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
      model: 'claude-3-haiku-20240307',
      max_tokens: 800,
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
              text: `Sen bir ilaç/vitamin/takviye tanıma uzmanısın. Bu fotoğrafı çok dikkatli analiz et.

KRITIK KURALLAR:
1. SADECE gerçek ilaç, vitamin, mineral veya takviye ürünü fotoğraflarını kabul et.
2. Fotoğrafta ilaç/vitamin/mineral/takviye YOKSA (yiyecek, içecek, nesne, manzara, hayvan, insan, rastgele obje vs.), kesinlikle şu JSON'u döndür:
{"found": false, "reason": "Fotoğrafta ilaç/vitamin/takviye ürünü tespit edilemedi"}
3. Fotoğraf bulanık veya okunamaz durumdaysa:
{"found": false, "reason": "Fotoğraf bulanık veya okunamaz durumda, lütfen daha net bir fotoğraf çekin"}

EĞER gerçek bir ilaç/vitamin/mineral/takviye ürünü tespit ettiysen:
- Kutu, şişe, blister ambalaj veya etiketteki YAZILARI dikkatlice oku
- Marka adını ve etken madde adını doğru şekilde oku, tahmin YAPMA
- Kutuda/ambalajda yazan dozaj bilgisini oku
- Prospektüs veya kutu üzerinde yazıyorsa günlük kullanım miktarını oku

Bu durumda aşağıdaki JSON formatında yanıt ver:
{
  "found": true,
  "confidence": 0.95,
  "name": "Kutuda/şişede yazan TAM İLAÇ ADI",
  "amount": 1,
  "times": ["08:00"],
  "duration": 0,
  "category": "ilac",
  "notes": "Kutuda yazan önemli bilgiler (dozaj, uyarılar vb.)"
}

ALAN AÇIKLAMALARI:
- found: true ise ilaç bulundu, false ise bulunamadı
- confidence: 0.0-1.0 arası, ilacı ne kadar net tanıdığın (0.7 altıysa found: false yap)
- name: Kutuda/etiket üzerinde YAZAN ilaç adı. Okunamıyorsa TAHMIN ETME, found: false döndür
- amount: Tek seferde kaç tablet/kapsül alınacağı (ambalajda yazıyorsa onu oku, yoksa 1)
- times: Günlük alım saatleri dizisi. Günde 1 kez: ["08:00"], 2 kez: ["08:00","20:00"], 3 kez: ["08:00","14:00","20:00"]
- duration: Kutu üzerinde kullanım süresi yazıyorsa gün olarak yaz, yoksa 0
- category: Aşağıdakilerden BİRİ:
  "ilac" = Reçeteli/reçetesiz ilaçlar (ağrı kesici, antibiyotik, tansiyon ilacı vb.)
  "vitamin" = Vitaminler (A, B1, B6, B12, C, D, E, K, multivitamin)
  "mineral" = Mineraller (Demir, Çinko, Magnezyum, Kalsiyum, Selenyum)
  "takviye" = Diğer takviyeler (Omega-3, Probiyotik, Koenzim Q10, Balık yağı)
- notes: Kutu üzerinde yazan önemli uyarılar veya kullanım talimatları

ÖNEMLİ:
- ASLA uydurma/tahmin ilaç adı verme
- İlaç adını kutu/etiket üzerinden oku, göremiyorsan found: false döndür
- confidence 0.7'nin altındaysa found: false döndür
- Yanıtın SADECE JSON olsun, başka hiçbir şey yazma`,
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

    // İlaç bulunamadı kontrolü
    if (result.found === false) {
      console.log('İlaç tespit edilemedi:', result.reason);
      return res.status(200).json({
        found: false,
        reason: result.reason || 'Fotoğrafta ilaç/vitamin/takviye ürünü tespit edilemedi'
      });
    }

    // Güven skoru kontrolü
    const confidence = parseFloat(result.confidence) || 0;
    if (confidence < 0.7) {
      console.log('Düşük güven skoru:', confidence);
      return res.status(200).json({
        found: false,
        reason: 'Fotoğraftaki ürün net olarak tanımlanamadı. Lütfen daha yakından ve net bir fotoğraf çekin.'
      });
    }

    // İlaç adı kontrolü - boş veya şüpheli mi?
    const nameStr = String(result.name || '').trim();
    const suspiciousNames = ['bilinmeyen', 'unknown', 'ilaç', 'vitamin', 'medicine', 'tablet', 'kapsül', 'capsule', 'pill'];
    if (!nameStr || nameStr.length < 2 || suspiciousNames.includes(nameStr.toLowerCase())) {
      console.log('Şüpheli/boş ilaç adı:', nameStr);
      return res.status(200).json({
        found: false,
        reason: 'İlaç adı okunamadı. Lütfen kutunun/etiketin adının göründüğü tarafını fotoğraflayın.'
      });
    }

    // Validate and sanitize result
    result.name = nameStr;
    result.found = true;
    result.confidence = confidence;
    result.amount = Math.max(1, Math.min(10, parseInt(result.amount) || 1));
    if (!['ilac', 'vitamin', 'mineral', 'takviye'].includes(result.category)) {
      result.category = 'ilac';
    }
    result.duration = parseInt(result.duration) || 0;
    if (result.duration <= 0) delete result.duration;
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
