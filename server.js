import express from 'express';
import Anthropic from '@anthropic-ai/sdk';
import fetch from 'node-fetch';
import multer from 'multer';
import cors from 'cors';
import dotenv from 'dotenv';
import { jsonrepair } from 'jsonrepair';
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

const uploadFields = upload.fields([
  { name: 'file', maxCount: 1 },
  { name: 'myFile', maxCount: 1 }
]);

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
app.post('/api/analyze', uploadFields, async (req, res) => {
  try {
    const { companyName, url, myCompanyName, myCompanyUrl, myCompanyDesc, myFileText, targetFileText } = req.body;
    const targetFile = req.files?.file?.[0];
    const myFile = req.files?.myFile?.[0];
    const clientApiKey = process.env.ANTHROPIC_API_KEY;

    if (!clientApiKey) {
      return res.status(500).json({ error: '伺服器未設定 API Key，請聯絡管理員' });
    }
    if (!companyName && !url && !targetFile) {
      return res.status(400).json({ error: '請至少提供公司名稱、網址或上傳檔案' });
    }

    const client = new Anthropic({ apiKey: clientApiKey });

    // Build my company context
    let myContext = '';
    if (myCompanyName) myContext += `我方公司／產品名稱：${myCompanyName}\n`;
    if (myCompanyDesc) myContext += `我方簡介：${myCompanyDesc}\n`;
    if (myCompanyUrl) {
      myContext += `我方官網：${myCompanyUrl}\n`;
      const myWebContent = await fetchUrlContent(myCompanyUrl);
      if (myWebContent) myContext += `我方網頁內容：\n${myWebContent}\n`;
    }
    if (myFile) {
      const myFileContent = myFile.buffer.toString('utf-8').slice(0, 3000);
      myContext += `我方簡介文件：\n${myFileContent}\n`;
    } else if (myFileText) {
      myContext += `我方簡介文件：\n${myFileText}\n`;
    }

    // Build target company context
    let context = '';
    if (companyName) context += `公司名稱：${companyName}\n`;
    if (url) {
      context += `公司網址：${url}\n`;
      const webContent = await fetchUrlContent(url);
      if (webContent) context += `\n網頁內容摘要：\n${webContent}\n`;
    }
    if (targetFile) {
      context += `\n上傳檔案名稱：${targetFile.originalname}\n`;
      const fileText = targetFile.buffer.toString('utf-8').slice(0, 6000);
      context += `檔案內容：\n${fileText}\n`;
    } else if (targetFileText) {
      context += `\n客戶資料文件內容：\n${targetFileText}\n`;
    }

    const systemPrompt = `你是一位資深商業顧問兼業務策略專家，擅長商業模式分析與業務開發。
請根據提供的公司資訊，進行深度分析並以 JSON 格式回覆，不要輸出任何 JSON 以外的文字。
重要：所有 JSON 字串值中不得包含未跳脫的雙引號、換行符或其他控制字元。請使用完整合法的 JSON 格式。
若有提供「我方資訊」，業務問答必須以我方的產品或服務為出發點，設計能自然帶出我方價值主張的破題問題，而非泛用型問題。

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

    const userPrompt = `請分析以下資訊，生成商業模式圖與業務拜訪問題。

${myContext ? `【我方資訊】\n${myContext}\n` : ''}【目標客戶資訊】\n${context}`;

    const message = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    });

    const fullText = message.content[0].text;

    // Strip markdown code fences if present
    const cleaned = fullText
      .replace(/```json\s*/gi, '')
      .replace(/```\s*/g, '')
      .trim();

    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error('No JSON found in response');
      return res.status(500).json({ error: 'AI 回傳格式錯誤，請重試' });
    }

    let parsed;
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch (e) {
      try {
        // Use jsonrepair to fix common JSON issues
        const repaired = jsonrepair(jsonMatch[0]);
        parsed = JSON.parse(repaired);
      } catch (e2) {
        console.error('JSON repair failed:', e2.message);
        return res.status(500).json({ error: 'AI 回傳格式錯誤，請重試' });
      }
    }

    res.json({ success: true, data: parsed });
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
