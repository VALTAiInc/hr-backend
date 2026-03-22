const express = require('express');
const cors = require('cors');
const fs = require('fs');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const PORT = process.env.PORT || 3000;
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const CASES_FILE = './hr_cases.json';

app.use(cors());
app.use(express.json());

const upload = multer({ storage: multer.memoryStorage() });

function readStore() {
  try {
    const raw = JSON.parse(fs.readFileSync(CASES_FILE, 'utf8'));
    if (Array.isArray(raw)) return { cases: raw, policy: null };
    return { cases: raw.cases || [], policy: raw.policy || null };
  } catch { return { cases: [], policy: null }; }
}
function writeStore(store) { fs.writeFileSync(CASES_FILE, JSON.stringify(store, null, 2)); }
function readCases() { return readStore().cases; }
function writeCases(cases) { const store = readStore(); writeStore({ ...store, cases }); }
function readPolicy() { return readStore().policy; }
function writePolicy(text) { const store = readStore(); writeStore({ ...store, policy: text }); }

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'VALT HR API', version: '2.0.0', timestamp: new Date().toISOString() }));

app.post('/api/hr/policies/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  const isPdf = req.file.mimetype === 'application/pdf' || req.file.originalname?.endsWith('.pdf');
  const isTxt = req.file.mimetype === 'text/plain' || req.file.originalname?.endsWith('.txt');
  if (!isPdf && !isTxt) return res.status(400).json({ error: 'Only PDF and TXT files are supported.' });
  try {
    const text = isTxt ? req.file.buffer.toString('utf8').trim() : (await pdfParse(req.file.buffer)).text.trim();
    writePolicy(text);
    res.json({ success: true, message: 'Policy uploaded successfully.', characters: text.length });
  } catch (err) {
    res.status(422).json({ error: 'Could not extract text from file.', detail: err.message });
  }
});

app.get('/api/hr/policies', (req, res) => {
  const text = readPolicy();
  if (!text) return res.status(404).json({ error: 'No policy uploaded yet.' });
  res.json({ policy: text, characters: text.length });
});

app.post('/api/hr/ask', async (req, res) => {
  const { question, jurisdiction = 'Ontario', companyPolicy: bodyPolicy } = req.body;
  if (!question) return res.status(400).json({ error: 'question is required' });
  const companyPolicy = bodyPolicy || readPolicy();
  const userContent = [`Jurisdiction: ${jurisdiction}`, companyPolicy ? `Company Policy:\n${companyPolicy}` : null, `Question: ${question}`, `\nRespond in JSON with exactly: answer (string), citations (array of strings), disclaimer (string).`].filter(Boolean).join('\n\n');
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514', max_tokens: 1500,
    system: 'You are an HR Intelligence assistant. Provide structured guidance on HR processes, progressive discipline, and employment standards. Reference legislation by name and section. Always recommend HR or legal review before termination. Never provide legal advice.',
    messages: [{ role: 'user', content: userContent }],
  });
  const raw = response.content[0].text;
  let parsed;
  try { const m = raw.match(/\{[\s\S]*\}/); parsed = JSON.parse(m ? m[0] : raw); }
  catch { parsed = { answer: raw, citations: [], disclaimer: 'Guidance only — not legal advice.' }; }
  res.json({ answer: parsed.answer ?? raw, citations: Array.isArray(parsed.citations) ? parsed.citations : [], disclaimer: parsed.disclaimer ?? 'Guidance only.', policyGrounded: !!companyPolicy });
});

app.post('/api/hr/legal', async (req, res) => {
  const { question, jurisdiction = 'Ontario', caseId } = req.body;
  if (!question) return res.status(400).json({ error: 'question is required' });
  const hrCase = caseId ? readCases().find(c => c.id === caseId) : null;
  const userContent = [`Jurisdiction: ${jurisdiction}`, hrCase ? `Case Details:\nEmployee: ${hrCase.employeeName}\nIssue Type: ${hrCase.issueType}\nIncidents: ${hrCase.incidents.length}\nStatus: ${hrCase.status}` : null, `Legal Question: ${question}`, `\nRespond in JSON with exactly: answer (string), citations (array of strings), riskLevel ("low", "medium", or "high"), disclaimer (string).`].filter(Boolean).join('\n\n');
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514', max_tokens: 1500,
    system: 'You are an employment law research assistant. Provide precise legal analysis citing specific statutes by name and section number. Assess legal risk level. This is legal information only, not legal advice.',
    messages: [{ role: 'user', content: userContent }],
  });
  const raw = response.content[0].text;
  let parsed;
  try { const m = raw.match(/\{[\s\S]*\}/); parsed = JSON.parse(m ? m[0] : raw); }
  catch { parsed = { answer: raw, citations: [], riskLevel: 'medium', disclaimer: 'Legal information only.' }; }
  res.json({ answer: parsed.answer ?? raw, citations: Array.isArray(parsed.citations) ? parsed.citations : [], riskLevel: ['low','medium','high'].includes(parsed.riskLevel) ? parsed.riskLevel : 'medium', disclaimer: parsed.disclaimer ?? 'Legal information only.' });
});

app.post('/api/hr/document', async (req, res) => {
  const { documentType, caseId, employeeName } = req.body;
  const validTypes = ['verbal-warning', 'written-warning', 'termination'];
  if (!documentType || !validTypes.includes(documentType)) return res.status(400).json({ error: `documentType must be one of: ${validTypes.join(', ')}` });
  if (!employeeName) return res.status(400).json({ error: 'employeeName is required' });
  const hrCase = caseId ? readCases().find(c => c.id === caseId) : null;
  const incidentSummary = hrCase?.incidents.length ? hrCase.incidents.map((inc, i) => `${i + 1}. [${inc.date?.slice(0,10) || 'N/A'}] (${inc.type}) ${inc.description}`).join('\n') : 'No incidents on record.';
  const docLabels = { 'verbal-warning': 'Verbal Warning Letter', 'written-warning': 'Written Warning Letter', 'termination': 'Termination Letter' };
  const userContent = [`Document Type: ${docLabels[documentType]}`, `Employee Name: ${employeeName}`, hrCase ? `Department: ${hrCase.department || 'N/A'}\nIssue Type: ${hrCase.issueType}\nJurisdiction: ${hrCase.jurisdiction || 'Ontario'}` : 'Jurisdiction: Ontario', `Incident History:\n${incidentSummary}`, `Today's Date: ${new Date().toISOString().slice(0,10)}`, `\nGenerate a complete, professional ${docLabels[documentType]} as a formal letter. Return only the letter text — no JSON, no preamble.`].filter(Boolean).join('\n\n');
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514', max_tokens: 1500,
    system: 'You are an HR document specialist. Generate formal, legally appropriate HR letters that are clear, professional, and factual.',
    messages: [{ role: 'user', content: userContent }],
  });
  const document = response.content[0].text.trim();
  res.json({ document, metadata: { documentType, employeeName, caseId: caseId || null, incidentCount: hrCase ? hrCase.incidents.length : 0, generatedAt: new Date().toISOString(), characters: document.length } });
});

app.post('/api/hr/cases', (req, res) => {
  const { employeeName, employeeTitle, department, managerId, issueType, jurisdiction = 'Ontario' } = req.body;
  if (!employeeName || !issueType) return res.status(400).json({ error: 'employeeName and issueType required' });
  const cases = readCases();
  const c = { id: Date.now().toString(), employeeName, employeeTitle, department, managerId, issueType, jurisdiction, status: 'open', incidents: [], createdAt: new Date().toISOString() };
  cases.push(c);
  writeCases(cases);
  res.json(c);
});

app.get('/api/hr/cases', (req, res) => res.json(readCases()));

app.get('/api/hr/cases/:id', (req, res) => {
  const c = readCases().find(c => c.id === req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  res.json(c);
});

app.post('/api/hr/cases/:id/incidents', (req, res) => {
  const { description, type, date } = req.body;
  if (!description || !type) return res.status(400).json({ error: 'description and type required' });
  const cases = readCases();
  const c = cases.find(c => c.id === req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  const incident = { id: Date.now().toString(), description, type, date: date || new Date().toISOString(), createdAt: new Date().toISOString() };
  c.incidents.push(incident);
  writeCases(cases);
  res.json(incident);
});

app.patch('/api/hr/cases/:id/status', (req, res) => {
  const { status } = req.body;
  if (!status) return res.status(400).json({ error: 'status required' });
  const cases = readCases();
  const c = cases.find(c => c.id === req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  c.status = status;
  writeCases(cases);
  res.json(c);
});

app.listen(PORT, () => {
  console.log(`\n🧠 VALT HR API`);
  console.log(`   Port: ${PORT}`);
  console.log(`   Endpoints: /health | /api/hr/ask | /api/hr/legal | /api/hr/document | /api/hr/cases | /api/hr/policies\n`);
});

// ─── Chat endpoint ────────────────────────────────────────────────────────────
const upload2 = multer({ dest: '/tmp/hr-uploads/' });
const FormData2 = require('form-data');

const HR_SYSTEM_PROMPT = `You are VALT HR Intelligence, an expert HR advisor specializing in Nova Scotia employment law. Answer questions about Nova Scotia employment law, HR processes, workplace policies, progressive discipline, termination, leaves, accommodations, harassment, and compensation. Reference the Nova Scotia Labour Standards Code, Human Rights Act, Occupational Health and Safety Act, and Workers Compensation Act. Be professional, clear and practical. Plain text only, no markdown. Note that AI guidance is informational only and legal counsel should be consulted for specific matters.`;

app.post('/api/chat', async (req, res) => {
  try {
    const { messages = [] } = req.body;
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: HR_SYSTEM_PROMPT,
      messages: messages.filter(m => m.role !== 'system'),
    });
    res.json({ content: response.content[0].text });
  } catch (err) {
    console.error('chat error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/transcribe', upload2.single('file'), async (req, res) => {
  try {
    const filePath = req.file?.path;
    if (!filePath) return res.status(400).json({ error: 'No audio file provided.' });
    const form = new FormData2();
    form.append('file', fs.createReadStream(filePath), { filename: 'recording.m4a', contentType: 'audio/m4a' });
    form.append('model', 'whisper-1');
    form.append('response_format', 'text');
    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, ...form.getHeaders() },
      body: form,
    });
    if (!response.ok) throw new Error('Whisper error ' + response.status);
    const text = await response.text();
    fs.unlink(filePath, () => {});
    res.json({ text: text.trim() });
  } catch (err) {
    console.error('transcribe error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/speak', async (req, res) => {
  try {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: 'No text provided.' });
    const voiceId = process.env.VOICE_EN || '21m00Tcm4TlvDq8ikWAM';
    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: 'POST',
      headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
      body: JSON.stringify({ text, model_id: 'eleven_turbo_v2', voice_settings: { stability: 0.5, similarity_boost: 0.8 } }),
    });
    if (!response.ok) throw new Error('ElevenLabs error ' + response.status);
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    res.set('Content-Type', 'audio/mpeg');
    res.send(buffer);
  } catch (err) {
    console.error('speak error:', err.message);
    res.status(500).json({ error: err.message });
  }
});
