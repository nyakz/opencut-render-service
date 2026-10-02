import express from 'express';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';

const execPromise = promisify(exec);
const app = express();
app.use(express.json());

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

app.post('/render', async (req, res) => {
  const { rawVideoKey, logoKey, editedVideoKey, hookText } = req.body;

  if (!rawVideoKey || !editedVideoKey) {
    return res.status(400).json({ error: 'Missing parameters' });
  }

  res.json({ status: 'Processing started in background' });

  const tmpDir = path.join('/tmp', `render-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  const rawPath = path.join(tmpDir, 'raw.mp4');
  const logoPath = path.join(tmpDir, 'logo.png');
  const outPath = path.join(tmpDir, 'out.mp4');

  try {
    console.log(`📥 Fetching ${rawVideoKey} from R2...`);
    const videoObj = await s3.send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: rawVideoKey }));
    await pipeline(videoObj.Body, fs.createWriteStream(rawPath));

    let hasLogo = false;
    if (logoKey && logoKey !== 'None') {
      try {
        const logoObj = await s3.send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: logoKey }));
        await pipeline(logoObj.Body, fs.createWriteStream(logoPath));
        hasLogo = true;
      } catch (e) {
        console.warn('Logo download failed, proceeding without watermark.');
      }
    }

    const sanitizedHook = (hookText || 'MUST WATCH!').replace(/'/g, "");
    let filterComplex = `[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920[v_bg]; ` +
      `[v_bg]drawtext=text='${sanitizedHook}':fontfile=/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf:fontsize=110:fontcolor=yellow:x=(w-text_w)/2:y=(h-text_h)/2:enable='between(t,0,3)'[v_hook]; `;

    if (hasLogo) {
      filterComplex += `[1:v]scale=180:-1[logo]; [v_hook][logo]overlay=80:160[v_out]; `;
    } else {
      filterComplex += `[v_hook]null[v_out]; `;
    }

    filterComplex += `[0:a]afade=t=in:st=0:d=0.2,afade=t=out:st=29.5:d=0.5,highpass=f=80[a_out]`;

    const logoInputFlag = hasLogo ? `-i "${logoPath}"` : '';
    const ffmpegCmd = `ffmpeg -y -i "${rawPath}" ${logoInputFlag} -filter_complex "${filterComplex}" -map "[v_out]" -map "[a_out]" -c:v libx264 -preset fast -crf 22 -c:a aac "${outPath}"`;

    console.log('⚡ Running FFmpeg Video Engine...');
    await execPromise(ffmpegCmd);

    console.log(`📤 Uploading finished video to R2 as ${editedVideoKey}...`);
    const fileStream = fs.createReadStream(outPath);
    await s3.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: editedVideoKey,
      Body: fileStream,
      ContentType: 'video/mp4',
    }));

    console.log('✅ Render pipeline executed successfully!');
  } catch (err) {
    console.error('❌ Render Error:', err);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`OpenCut Render Engine running on port ${PORT}`));
