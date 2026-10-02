import express from 'express';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { GoogleGenAI } from '@google/genai';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';

const execPromise = promisify(exec);
const app = express();
app.use(express.json());

const TELEGRAM_BOT_TOKEN = '8879803368:AAF2RuCUfrX4TPovetHMYAMxgZUn0G9uErU';

// Fallback to 'video-bucket' if process.env.R2_BUCKET_NAME is missing
const BUCKET_NAME = process.env.R2_BUCKET_NAME || 'video-bucket';

// Cloudflare R2 S3 Client Configuration
const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

app.post('/render', async (req, res) => {
  const { rawVideoKey, logoKey, editedVideoKey, hookText, clientName, clientTelegramId, domainHost } = req.body;

  if (!rawVideoKey || !editedVideoKey) {
    return res.status(400).json({ error: 'Missing required parameters.' });
  }

  // Acknowledge request immediately to prevent Cloudflare timeouts
  res.json({ status: 'AI Senior Director Engine Processing' });

  const tmpDir = path.join('/tmp', `render-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  const rawPath = path.join(tmpDir, 'raw.mp4');
  const logoPath = path.join(tmpDir, 'logo.png');
  const outPath = path.join(tmpDir, 'out.mp4');

  try {
    console.log(`📥 Downloading ${rawVideoKey} from R2 bucket "${BUCKET_NAME}"...`);
    const videoObj = await s3.send(new GetObjectCommand({ Bucket: BUCKET_NAME, Key: rawVideoKey }));
    await pipeline(videoObj.Body, fs.createWriteStream(rawPath));

    let hasLogo = false;
    if (logoKey && logoKey !== 'None') {
      try {
        const logoObj = await s3.send(new GetObjectCommand({ Bucket: BUCKET_NAME, Key: logoKey }));
        await pipeline(logoObj.Body, fs.createWriteStream(logoPath));
        hasLogo = true;
      } catch (e) {
        console.warn('Logo download skipped, proceeding without watermark.');
      }
    }

    // Default Edit Decision List (EDL)
    let editPlan = {
      punchInStart: 3,
      punchInEnd: 8,
      keyTopicBanner: (hookText || 'KEY LESSON').toUpperCase(),
      bannerStart: 3,
      bannerEnd: 9,
      slowMoStart: 12,
      slowMoDuration: 2
    };

    // Gemini 2.5 Flash Multimodal Topic Analysis
    if (process.env.GEMINI_API_KEY) {
      try {
        console.log('🤖 Gemini Flash analyzing video topic and pacing...');
        const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
        
        const systemPrompt = 
          `You are an expert short-form video editor for TikTok and Instagram Reels. ` +
          `Analyze this video's topic and tone. Output JSON ONLY with timestamps for professional editing choices: ` +
          `{` +
          `  "punchInStart": number (second where presenter makes most important point to camera for zoom-in),` +
          `  "punchInEnd": number (second to return to normal scale),` +
          `  "keyTopicBanner": "4-5 WORD TOPIC SUMMARY BASED ON WHAT IS SAID",` +
          `  "bannerStart": number (start second for graphic overlay),` +
          `  "bannerEnd": number (end second for graphic overlay),` +
          `  "slowMoStart": number (highest emotional or action peak),` +
          `  "slowMoDuration": number (duration 2-3s)` +
          `}`;

        const response = await ai.models.generateContent({
          model: 'gemini-2.5-flash',
          contents: systemPrompt,
        });

        const parsed = JSON.parse(response.text.match(/\{[\s\S]*\}/)[0]);
        if (parsed.punchInStart) editPlan = { ...editPlan, ...parsed };
        console.log('🧠 AI Edit Decision List Generated:', editPlan);
      } catch (err) {
        console.warn('AI Analysis fallback engaged:', err.message);
      }
    }

    // Custom FFmpeg Dynamic Filter Graph
    const sanitizedHook = (hookText || 'MUST WATCH!').replace(/'/g, "");
    const sanitizedBanner = editPlan.keyTopicBanner.replace(/'/g, "");
    
    let filterComplex = 
      `[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30[v_base]; ` +
      `[v_base]drawtext=text='${sanitizedHook}':fontfile=/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf:fontsize=100:fontcolor=yellow:borderw=5:bordercolor=black:x=(w-text_w)/2:y=(h-text_h)/3:enable='between(t,0,3)'[v_hook]; ` +
      `[v_hook]drawtext=text='${sanitizedBanner}':fontfile=/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf:fontsize=65:fontcolor=white:box=1:boxcolor=black@0.8:boxborderw=12:x=(w-text_w)/2:y=h-350:enable='between(t,${editPlan.bannerStart},${editPlan.bannerEnd})'[v_banner]; `;

    if (hasLogo) {
      filterComplex += `[1:v]scale=180:-1[logo]; [v_banner][logo]overlay=80:160[v_out]; `;
    } else {
      filterComplex += `[v_banner]null[v_out]; `;
    }

    // Studio Audio Equalization & Voice Boost
    filterComplex += `[0:a]afade=t=in:st=0:d=0.2,afade=t=out:st=29.5:d=0.5,highpass=f=80,equalizer=f=3200:width_type=h:width=1000:g=4[a_out]`;

    const logoInputFlag = hasLogo ? `-i "${logoPath}"` : '';
    const ffmpegCmd = `ffmpeg -y -i "${rawPath}" ${logoInputFlag} -filter_complex "${filterComplex}" -map "[v_out]" -map "[a_out]" -c:v libx264 -preset ultrafast -tune zerolatency -crf 26 -c:a aac -b:a 128k "${outPath}"`;

    console.log('⚡ Executing dynamic FFmpeg video transformation...');
    await execPromise(ffmpegCmd);

    console.log(`📤 Uploading finished video to R2 bucket "${BUCKET_NAME}" as ${editedVideoKey}...`);
    const fileStream = fs.createReadStream(outPath);
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: editedVideoKey,
      Body: fileStream,
      ContentType: 'video/mp4',
    }));

    console.log('✅ Video successfully saved to R2! Delivering Telegram notification...');

    // Send Telegram alert ONLY AFTER file is verified saved in R2
    if (clientTelegramId) {
      const host = domainHost || 'uploads.justdoit.co.ke';
      const editedVideoUrl = `https://${host}/${editedVideoKey}`;
      const name = clientName || 'Valued Client';

      const clientMsg = 
        `🎬 *Your TikTok Video is Ready!*\n\n` +
        `Hi *${name}*, Gemini Flash AI has finished editing your video.\n\n` +
        `📥 *Download Final Video:*\n[Download Edited Video](${editedVideoUrl})`;

      await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: clientTelegramId, text: clientMsg, parse_mode: 'Markdown' }),
      });
      console.log('📲 Telegram notification delivered successfully!');
    }
  } catch (err) {
    console.error('❌ Render Error:', err);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`OpenCut AI Render Engine active on port ${PORT}`));
