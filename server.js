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

  res.json({ status: 'Multi-Camera AI Engine Initialized' });

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

    let cameraCuts = [
      { start: 0, end: 2.5, angle: 'close_up' },
      { start: 2.5, end: 6.0, angle: 'wide' },
      { start: 6.0, end: 10.0, angle: 'side_left' }
    ];
    let aeoSearchTitle = (hookText || 'VIRAL EDIT SECRETS').toUpperCase();

    // Gemini Flash Multi-Cam Director Analysis
    if (process.env.GEMINI_API_KEY) {
      try {
        console.log('🤖 Gemini Flash directing camera angle cuts & AEO titles...');
        const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
        
        const systemPrompt = 
          `You are a live TV switcher & short-form video director. ` +
          `Analyze this video's topic. Output JSON ONLY with an AEO search title and camera angle cuts: ` +
          `{` +
          `  "aeoSearchTitle": "3-4 WORD HIGH-INTENT SEARCH TITLE",` +
          `  "cuts": [` +
          `    {"start": 0, "end": 2.5, "angle": "close_up"},` +
          `    {"start": 2.5, "end": 6, "angle": "wide"},` +
          `    {"start": 6, "end": 10, "angle": "side_left"}` +
          `  ]` +
          `}`;

        const response = await ai.models.generateContent({
          model: 'gemini-2.5-flash',
          contents: systemPrompt,
        });

        const parsed = JSON.parse(response.text.match(/\{[\s\S]*\}/)[0]);
        if (parsed.cuts) cameraCuts = parsed.cuts;
        if (parsed.aeoSearchTitle) aeoSearchTitle = parsed.aeoSearchTitle;
      } catch (err) {
        console.warn('AI Multi-Cam fallback engaged:', err.message);
      }
    }

    const sanitizedHook = (hookText || 'MUST WATCH!').replace(/'/g, "");
    const sanitizedAEOTitle = aeoSearchTitle.replace(/'/g, "");

    // Build FFmpeg Multi-Cam Filter Graph
    let filterComplex = 
      `[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30,eq=contrast=1.08:brightness=0.03:saturation=1.12,hqdn3d=1.5:1.5:6:6[v_clean]; ` +
      `[v_clean]split=3[v_cam1][v_cam2][v_cam3]; ` +
      `[v_cam1]trim=${cameraCuts[0].start}:${cameraCuts[0].end},scale=1350:2400,crop=1080:1920,setpts=PTS-STARTPTS[v_cut1]; ` +
      `[v_cam2]trim=${cameraCuts[1].start}:${cameraCuts[1].end},setpts=PTS-STARTPTS[v_cut2]; ` +
      `[v_cam3]trim=${cameraCuts[2].start}:${cameraCuts[2].end},scale=1296:2304,crop=1080:1920:100:100,setpts=PTS-STARTPTS[v_cut3]; ` +
      `[v_cut1][v_cut2][v_cut3]concat=n=3:v=1:a=0[v_switched]; ` +
      `[v_switched]drawtext=text='${sanitizedHook}':fontfile=/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf:fontsize=100:fontcolor=yellow:borderw=6:bordercolor=black:shadowcolor=black@0.6:shadowx=6:shadowy=6:x=(w-text_w)/2:y=(h-text_h)/2-120:enable='between(t,0,2.5)'[v_hook_txt]; ` +
      `[v_hook_txt]drawtext=text='${sanitizedAEOTitle}':fontfile=/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf:fontsize=62:fontcolor=white:box=1:boxcolor=black@0.85:boxborderw=14:x=(w-text_w)/2:y=h-420:enable='between(t,2,9)'[v_banner]; `;

    // 45% Transparent Bottom-Center Logo
    if (hasLogo) {
      filterComplex += 
        `[1:v]scale=220:-1,format=rgba,colorchannelmixer=aa=0.45[logo_trans]; ` +
        `[v_banner][logo_trans]overlay=x=(main_w-overlay_w)/2:y=main_h-overlay_h-260[v_out]; `;
    } else {
      filterComplex += `[v_banner]null[v_out]; `;
    }

    // Studio Lip-Sync Audio Chain
    filterComplex += `[0:a]afade=t=in:st=0:d=0.15,afade=t=out:st=29.5:d=0.5,highpass=f=80,equalizer=f=3200:width_type=h:width=1000:g=4,acompressor=threshold=-20dB:ratio=4:attack=20:release=250[a_out]`;

    const logoInputFlag = hasLogo ? `-i "${logoPath}"` : '';
    const ffmpegCmd = `ffmpeg -y -i "${rawPath}" ${logoInputFlag} -filter_complex "${filterComplex}" -map "[v_out]" -map "[a_out]" -c:v libx264 -preset ultrafast -tune zerolatency -crf 25 -c:a aac -b:a 128k "${outPath}"`;

    console.log('⚡ Executing Multi-Camera Render Engine...');
    await execPromise(ffmpegCmd);

    console.log(`📤 Saving to R2 bucket "${BUCKET_NAME}" as ${editedVideoKey}...`);
    const fileStream = fs.createReadStream(outPath);
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: editedVideoKey,
      Body: fileStream,
      ContentType: 'video/mp4',
    }));

    console.log('✅ Video saved! Delivering Telegram link...');

    if (clientTelegramId) {
      const host = domainHost || 'uploads.justdoit.co.ke';
      const editedVideoUrl = `https://${host}/${editedVideoKey}`;
      const name = clientName || 'Valued Client';

      const clientMsg = 
        `🎬 *Your Multi-Cam TikTok Video is Ready!*\n\n` +
        `Hi *${name}*, Gemini Flash AI has directed dynamic camera angles, lighting filters, and studio audio mastering.\n\n` +
        `📥 *Download Final Video:*\n[Download Edited Video](${editedVideoUrl})`;

      await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: clientTelegramId, text: clientMsg, parse_mode: 'Markdown' }),
      });
      console.log('📲 Telegram notification delivered!');
    }
  } catch (err) {
    console.error('❌ Render Error:', err);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`OpenCut AI Engine active on port ${PORT}`));
