import express from 'express';
import Anthropic from '@anthropic-ai/sdk';
import fetch from 'node-fetch';
import multer from 'multer';
import cors from 'cors';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Multer for file uploads (in memory)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const allowed = ['application/pdf', 'text/plain', 'text/html',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
    if (allowed.includes(file.mimetype) || file.originalname.match(/\.(txt|pdf|doc|docx|html)$/i)) {
      cb(null, true);
    } else {
      cb(new Error('僅支援 PDF、TXT、DOC、DOCX、HTML 格式'));
    }
  }
});

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(__dirname));

// ── Utility: fetch URL content ────────────────────────────────────────────────
async function fetchUrlContent(url) {
  try {
    if (!url.startsWith('http')) url = 'https://' + url;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BusinessCanvasBot/1.0)' },
      signal: AbortSignal.timeout(10000)
    });
    const html = await res.text();
    // Strip HTML tags
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 8000);
    return text;
  } catch (e) {
    return null;
  }
}

// ── Main analysis endpoint ─────────────────────────────────────────────────────
app.post('/api/analyze', upload.single('file'), async (req, res) => {
  try {
    const { companyName, url, apiKey } = req.body;
    const clientApiKey = apiKey || process.env.ANTHROPIC_API_KEY;

    if (!clientApiKey) {
      return res.status(400).json({ error: '請提供 Claude API Key' });
    }
    if (!companyName && !url && !req.file) {
      return res.status(400).json({ error: '請至少提供公司名稱、網址或上傳檔案' });
    }

    const client = new Anthropic({ apiKey: clientApiKey });

    // Build context
    let context = '';
    if (companyName) context += `公司名稱：${companyName}\n`;
    if (url) {
      context += `公司網址：${url}\n`;
      const webContent = await fetchUrlContent(url);
      if (webContent) context += `\n網頁內容摘要：\n${webContent}\n`;
    }
    if (req.file) {
      context += `\n上傳檔案名稱：${req.file.originalname}\n`;
      const fileText = req.file.buffer.toString('utf-8').slice(0, 6000);
      context += `檔案內容：\n${fileText}\n`;
    }

    const systemPrompt = `你是一位資深商業顧問兼業務策略專家，擅長商業模式分析與業務開發。
請根據提供的公司資訊，進行深度分析並以 JSON 格式回覆，不要輸出任何 JSON 以外的文字。

JSON 結構必須完全符合以下格式：
{
  "companyName": "公司完整名稱",
  "companyOverview": "公司概述（2-3句話）",
  "industry": "所屬產業",
  "canvas": {
    "customerSegments": {
      "title": "客戶區隔",
      "items": ["項目1", "項目2", "...至少3項"]
    },
    "valuePropositions": {
      "title": "價值主張",
      "items": ["項目1", "項目2", "...至少3項"]
    },
    "channels": {
      "title": "通路",
      "items": ["項目1", "項目2", "...至少3項"]
    },
    "customerRelationships": {
      "title": "顧客關係",
      "items": ["項目1", "項目2", "...至少3項"]
    },
    "revenueStreams": {
      "title": "收益流",
      "items": ["項目1", "項目2", "...至少3項"]
    },
    "keyResources": {
      "title": "關鍵資源",
      "items": ["項目1", "項目2", "...至少3項"]
    },
    "keyActivities": {
      "title": "關鍵活動",
      "items": ["項目1", "項目2", "...至少3項"]
    },
    "keyPartnerships": {
      "title": "關鍵合作夥伴",
      "items": ["項目1", "項目2", "...至少3項"]
    },
    "costStructure": {
      "title": "成本結構",
      "items": ["項目1", "項目2", "...至少3項"]
    }
  },
  "qa": [
    {
      "id": 1,
      "category": "類別（如：業務痛點、市場機會、競爭態勢、技術需求、組織決策等）",
      "question": "第一次業務拜訪時的破題提問（中文，自然口語化）",
      "suggestedAnswer": "建議的引導方向或預期回答（說明你希望客戶往哪個方向思考）",
      "followUp": "後續追問（可選）",
      "source": "此問題的設計來由與策略說明（說明為何問這個問題、根據什麼商業邏輯、參考哪些業務技巧或方法論）"
    }
  ]
}

qa 陣列必須包含至少 10 題，涵蓋：業務痛點(2題)、市場機會(2題)、競爭態勢(1題)、技術/產品需求(2題)、組織與決策(1題)、預算與時程(1題)、未來規劃(1題)。
每個 source 欄位請具體說明方法論依據，例如 SPIN Selling、Solution Selling、挑戰式銷售、BANT 框架、5 Why 等。`;

    const userPrompt = `請分析以下公司資訊，生成商業模式圖與業務拜訪問題：\n\n${context}`;

    // Stream response
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    let fullText = '';

    const stream = await client.messages.stream({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    });

    for await (const chunk of stream) {
      if (chunk.type === 'content_block_delta' && chunk.delta.type === 'text_delta') {
        fullText += chunk.delta.text;
        res.write(`data: ${JSON.stringify({ type: 'delta', text: chunk.delta.text })}\n\n`);
      }
    }

    // Parse and validate JSON
    try {
      const jsonMatch = fullText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON found');
      const parsed = JSON.parse(jsonMatch[0]);
      res.write(`data: ${JSON.stringify({ type: 'complete', data: parsed })}\n\n`);
    } catch (e) {
      res.write(`data: ${JSON.stringify({ type: 'error', message: '解析結果時發生錯誤，請重試' })}\n\n`);
    }

    res.end();
  } catch (err) {
    console.error(err);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message || '伺服器錯誤，請稍後重試' });
    } else {
      res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
      res.end();
    }
  }
});

app.get('/', (req, res) => {
  res.sendFile(join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n✅ Business Canvas Generator 已啟動`);
  console.log(`👉 請開啟瀏覽器前往 http://localhost:${PORT}\n`);
});
