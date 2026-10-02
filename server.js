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

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8879803368:AAF2RuCUfrX4TPovetHMYAMxgZUn0G9uErU';
const BUCKET_NAME = process.env.R2_BUCKET_NAME || 'video-bucket';

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

  res.json({ status: 'Processing Low-Memory Render Job' });

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
        console.warn('Logo download skipped.');
      }
    }

    let aeoSearchTitle = (hookText || 'MUST WATCH EDIT').toUpperCase();

    if (process.env.GEMINI_API_KEY) {
      try {
        console.log('🤖 AI Analyzing topic...');
        const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
        const response = await ai.models.generateContent({
          model: 'gemini-2.5-flash',
          contents: `Analyze video topic for text overlay. Output JSON ONLY: {"aeoSearchTitle": "3-4 WORD SUMMARY"}`,
        });
        const parsed = JSON.parse(response.text.match(/\{[\s\S]*\}/)[0]);
        if (parsed.aeoSearchTitle) aeoSearchTitle = parsed.aeoSearchTitle;
      } catch (err) {
        console.warn('AI fallback engaged:', err.message);
      }
    }

    const sanitizedHook = (hookText || 'MUST WATCH!').replace(/'/g, "");
    const sanitizedAEOTitle = aeoSearchTitle.replace(/'/g, "");

    // LOW-MEMORY SINGLE-PASS FILTER GRAPH
    // Avoids memory-heavy concatenations and multi-scale split buffers
    let filterComplex = 
      `[0:v]fps=30,scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920[v_base]; ` +
      `[v_base]drawtext=text='${sanitizedHook}':fontfile=/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf:fontsize=60:fontcolor=yellow:box=1:boxcolor=black@0.75:boxborderw=10:x=(w-text_w)/2:y=(h-text_h)/2-180:enable='between(t,0,3)'[v_hook_txt]; ` +
      `[v_hook_txt]drawtext=text='${sanitizedAEOTitle}':fontfile=/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf:fontsize=50:fontcolor=white:box=1:boxcolor=black@0.85:boxborderw=12:x=(w-text_w)/2:y=h-380:enable='between(t,3,8.5)'[v_banner]; `;

    // Far-Left Bottom Logo Placement (x=0, y=bottom)
    if (hasLogo) {
      filterComplex += 
        `[1:v]scale=180:-1,format=rgba,colorchannelmixer=aa=0.45[logo_trans]; ` +
        `[v_banner][logo_trans]overlay=x=0:y=main_h-overlay_h:format=auto[v_out]; `;
    } else {
      filterComplex += `[v_banner]null[v_out]; `;
    }

    filterComplex += `[0:a]afade=t=in:st=0:d=0.15,afade=t=out:st=29.5:d=0.5,highpass=f=80,equalizer=f=3200:width_type=h:width=1000:g=3.5[a_out]`;

    const logoInputFlag = hasLogo ? `-i "${logoPath}"` : '';
    
    // Limits RAM usage via single-threaded ultrafast preset (-threads 1)
    const ffmpegCmd = `ffmpeg -y -threads 1 -i "${rawPath}" ${logoInputFlag} -filter_complex "${filterComplex}" -map "[v_out]" -map "[a_out]" -c:v libx264 -preset ultrafast -r 30 -pix_fmt yuv420p -movflags +faststart -c:a aac -b:a 128k "${outPath}"`;

    console.log('⚡ Executing Low-Memory FFmpeg Render...');
    await execPromise(ffmpegCmd);

    console.log(`📤 Uploading finished file to R2 as ${editedVideoKey}...`);
    const fileStream = fs.createReadStream(outPath);
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: editedVideoKey,
      Body: fileStream,
      ContentType: 'video/mp4',
    }));

    console.log('✅ Video successfully saved to R2! Delivering Telegram notification...');

    if (clientTelegramId) {
      const host = domainHost || 'uploads.justdoit.co.ke';
      const editedVideoUrl = `https://${host}/${editedVideoKey}`;
      const name = clientName || 'Valued Client';

      const clientMsg = 
        `🎬 *Your TikTok Video is Ready!*\n\n` +
        `Hi *${name}*, your edit has finished rendering.\n\n` +
        `📥 *Download Video:*\n[Download Final Video](${editedVideoUrl})`;

      const tgRes = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: clientTelegramId, text: clientMsg, parse_mode: 'Markdown' }),
      });
      
      const tgJson = await tgRes.json();
      console.log('📲 Telegram API Response:', tgJson);
    }
  } catch (err) {
    console.error('❌ Render Failure:', err.stack || err.message);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`OpenCut Engine online on port ${PORT}`));
