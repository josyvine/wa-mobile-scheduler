const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const multer = require('multer');
const fs = require('fs-extra');
const path = require('path');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

app.use(cors({ origin: '*' }));
app.use(express.json());

const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

const uploadDir = path.join(__dirname, 'uploads');
fs.ensureDirSync(uploadDir);

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage: storage });

// --- STABLE CLIENT CONFIGURATION ---
const client = new Client({
    authStrategy: new LocalAuth({ 
        dataPath: path.join(__dirname, 'uploads', 'wauth') 
    }),
    puppeteer: {
        executablePath: '/usr/bin/google-chrome-stable',
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage', // <--- FIXES THE "SESSION CLOSED" ERROR
            '--disable-gpu',
            '--disable-extensions',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-notifications'
            // REMOVED '--single-process' BECAUSE IT CAUSED THE CRASH
        ]
    }
});

const scheduledTasks = new Map();
let isReady = false;

client.on('qr', (qr) => {
    console.log('QR Code Generated');
    io.emit('qr_code', qr);
});

client.on('ready', () => {
    console.log('WhatsApp Client Ready');
    isReady = true;
    io.emit('ready', true);
});

client.on('disconnected', (reason) => {
    console.log('Disconnected:', reason);
    isReady = false;
    io.emit('disconnected', reason);
    client.initialize();
});

client.initialize();

// --- ROUTES ---

app.get('/api/groups', async (req, res) => {
    if (!isReady) return res.status(503).json({ error: 'Not ready' });
    try {
        const chats = await client.getChats();
        const groups = chats.filter(c => c.isGroup).map(c => ({ name: c.name, id: c.id._serialized }));
        res.json(groups);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/schedule', upload.single('image'), (req, res) => {
    const { groupId, scheduleTime, uiId } = req.body;
    const file = req.file;
    
    if (!file) return res.status(400).json({ error: 'No file' });

    const delay = new Date(scheduleTime).getTime() - Date.now();
    
    if (delay < 0) {
        fs.unlink(file.path, ()=>{});
        return res.status(400).json({ error: 'Past time' });
    }

    const timeout = setTimeout(async () => {
        try {
            if (fs.existsSync(file.path)) {
                const media = MessageMedia.fromFilePath(file.path);
                await client.sendMessage(groupId, media);
                io.emit('message_sent', { id: uiId });
                fs.unlink(file.path, ()=>{});
            }
            scheduledTasks.delete(uiId);
        } catch (e) { console.error(e); }
    }, delay);

    scheduledTasks.set(uiId, { timeout, filePath: file.path });
    res.json({ status: 'Scheduled', id: uiId });
});

app.post('/api/cancel', (req, res) => {
    const { id } = req.body;
    if (scheduledTasks.has(id)) {
        const t = scheduledTasks.get(id);
        clearTimeout(t.timeout);
        if (fs.existsSync(t.filePath)) fs.unlinkSync(t.filePath);
        scheduledTasks.delete(id);
        res.json({ status: 'Cancelled' });
    } else {
        res.status(404).json({ error: 'Not found' });
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on ${PORT}`));