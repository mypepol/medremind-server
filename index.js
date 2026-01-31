const express = require('express');
const cors = require('cors');
const multer = require('multer');
const Anthropic = require('@anthropic-ai/sdk');
const sharp = require('sharp');
const fs = require('fs');

require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const uploadDir = 'uploads';
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir);
}

const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Sadece resim dosyaları kabul edilir'));
    }
  },
});

const AnthropicClient = Anthropic.default || Anthropic;
const anthropic = new AnthropicClient({
  apiKey: (process.env.ANTHROPIC_API_KEY || '').trim(),
});

app.get('/health', (_req, res) => {
  const key = process.env.ANTHROPIC_API_KEY || '';
  res.json({
    status: 'ok',
    hasApiKey: key.length > 0,
    keyPrefix: key.substring(0, 10) + '...',
    keyLength: key.length
  });
});

app.post('/analyze', upload.single('photo'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Fotoğraf gerekli' });
  }

  try {
    let imageBuffer = fs.readFileSync(req.file.path);
    const MAX_SIZE = 4 * 1024 * 1024; // 4MB (API limiti 5MB, güvenli margin)

    // Fotoğraf çok büyükse küçült ve sıkıştır
    if (imageBuffer.length > MAX_SIZE) {
      console.log(`Görsel çok büyük (${(imageBuffer.length / 1024 / 1024).toFixed(1)}MB), sıkıştırılıyor...`);
      imageBuffer = await sharp(imageBuffer)
        .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 70 })
        .toBuffer();
      console.log(`Sıkıştırıldı: ${(imageBuffer.length / 1024 / 1024).toFixed(1)}MB`);
    }

    const base64 = imageBuffer.toString('base64');
    const mediaType = imageBuffer.length !== fs.readFileSync(req.file.path).length ? 'image/jpeg' : (req.file.mimetype || 'image/jpeg');

    const response = await anthropic.messages.create({
      model: 'claude-3-5-haiku-20241022',
      max_tokens: 512,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: mediaType,
                data: base64,
              },
            },
            {
              type: 'text',
              text: `Bu ilaç/vitamin/takviye fotoğrafını analiz et. Aşağıdaki JSON formatında yanıt ver, başka hiçbir şey yazma:
{
  "name": "İlaç/vitamin adı",
  "amount": 1,
  "times": ["08:00"],
  "category": "ilac|vitamin|mineral|takviye",
  "notes": "Varsa ek bilgi"
}

amount: Tek seferde kaç adet/tablet alınacağı (sayı olarak, örn: 1, 2)
Kategori seçenekleri:
- "ilac": Reçeteli veya reçetesiz ilaçlar
- "vitamin": Vitaminler (A, B, C, D, E, K vb.)
- "mineral": Mineraller (Demir, Çinko, Magnezyum vb.)
- "takviye": Diğer takviyeler (Omega-3, Probiyotik vb.)

Eğer günde birden fazla alınması gerekiyorsa times dizisine birden fazla saat ekle.
Fotoğraftan okunamayan bilgileri makul varsayımlarla doldur.`,
            },
          ],
        },
      ],
    });

    const text = response.content[0].type === 'text' ? response.content[0].text : '';
    console.log('AI raw response:', text);

    const jsonMatch = text.match(/\{[\s\S]*\}/);

    if (!jsonMatch) {
      console.error('No JSON found in response:', text);
      return res.status(422).json({ error: 'Analiz sonucu ayrıştırılamadı' });
    }

    // Clean the JSON string - remove control characters and fix common issues
    let cleanJson = jsonMatch[0]
      .replace(/[\x00-\x1F\x7F]/g, ' ')  // Remove control characters
      .replace(/,\s*}/g, '}')              // Remove trailing commas
      .replace(/,\s*]/g, ']')              // Remove trailing commas in arrays
      .replace(/\/\/.*/g, '')              // Remove single-line comments
      .replace(/\/\*[\s\S]*?\*\//g, '');   // Remove multi-line comments

    let result;
    try {
      result = JSON.parse(cleanJson);
    } catch (parseErr) {
      console.error('JSON parse failed, trying fallback. Raw:', cleanJson);
      // Fallback: try to extract fields manually
      const nameMatch = cleanJson.match(/"name"\s*:\s*"([^"]+)"/);
      const amountMatch = cleanJson.match(/"amount"\s*:\s*(\d+)/);
      const categoryMatch = cleanJson.match(/"category"\s*:\s*"(ilac|vitamin|mineral|takviye)"/);
      const timesMatch = cleanJson.match(/"times"\s*:\s*\[([^\]]*)\]/);
      const notesMatch = cleanJson.match(/"notes"\s*:\s*"([^"]+)"/);

      if (!nameMatch) {
        return res.status(422).json({ error: 'Analiz sonucu okunamadı. Lütfen tekrar deneyin.' });
      }

      const times = timesMatch
        ? timesMatch[1].match(/"(\d{2}:\d{2})"/g)?.map(t => t.replace(/"/g, '')) || ['08:00']
        : ['08:00'];

      result = {
        name: nameMatch[1],
        amount: amountMatch ? parseInt(amountMatch[1]) : 1,
        category: categoryMatch ? categoryMatch[1] : 'ilac',
        times: times,
        notes: notesMatch ? notesMatch[1] : undefined,
      };
    }

    // Validate and sanitize result
    result.name = String(result.name || 'Bilinmeyen İlaç');
    result.amount = Math.max(1, Math.min(10, parseInt(result.amount) || 1));
    if (!['ilac', 'vitamin', 'mineral', 'takviye'].includes(result.category)) {
      result.category = 'ilac';
    }
    if (!Array.isArray(result.times) || result.times.length === 0) {
      result.times = ['08:00'];
    }
    // Validate time format
    result.times = result.times.filter(t => /^\d{2}:\d{2}$/.test(t));
    if (result.times.length === 0) result.times = ['08:00'];

    console.log('Final result:', result);
    res.json(result);
  } catch (error) {
    console.error('Analiz hatası:', error.message, error.stack);
    res.status(500).json({ error: error.message || 'Fotoğraf analiz edilemedi' });
  } finally {
    if (req.file?.path) {
      fs.unlink(req.file.path, () => {});
    }
  }
});

app.listen(PORT, () => {
  console.log(`Sunucu http://localhost:${PORT} adresinde çalışıyor`);
  console.log(`\nŞimdi yeni bir CMD'de şu komutu çalıştırın:`);
  console.log(`  ngrok http ${PORT}`);
  console.log(`\nNgrok URL'sini config.ts dosyasına koyun.`);
});
