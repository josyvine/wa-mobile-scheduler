const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const multer = require('multer');
const fs = require('fs-extra');
const path = require('path');
const cors = require('cors');

// --- SETUP SERVER ---
const app = express();
const server = http.createServer(app);

// Enable CORS so your phone's HTML can talk to this server
app.use(cors({ origin: '*' }));
app.use(express.json());

// Setup Real-time communication
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// --- STORAGE CONFIGURATION ---
// We use the 'uploads' folder so files are not deleted immediately
const uploadDir = path.join(__dirname, 'uploads');
fs.ensureDirSync(uploadDir);

// Configure file upload storage
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        // Name file: timestamp-originalName (e.g., 17000000-photo.jpg)
        cb(null, Date.now() + '-' + file.originalname);
    }
});
const upload = multer({ storage: storage });

// --- WHATSAPP CLIENT CONFIGURATION (LOW MEMORY MODE) ---
const client = new Client({
    // Save login session in the uploads folder for persistence
    authStrategy: new LocalAuth({ 
        dataPath: path.join(__dirname, 'uploads', 'wauth') 
    }),
    puppeteer: {
        // Point to the Chrome installed by Dockerfile
        executablePath: '/usr/bin/google-chrome-stable',
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            // MEMORY OPTIMIZATIONS FOR FREE TIER:
            '--disable-extensions',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process', 
            '--disable-notifications'
        ]
    }
});

// Track scheduled tasks in memory
const scheduledTasks = new Map();

let isReady = false;

// --- WHATSAPP EVENTS ---

// 1. Generate QR Code
client.on('qr', (qr) => {
    console.log('QR Code generated');
    io.emit('qr_code', qr);
});

// 2. Client Connected
client.on('ready', () => {
    console.log('WhatsApp Client is ready!');
    isReady = true;
    io.emit('ready', true);
});

// 3. Client Disconnected (Auto-Restart)
client.on('disconnected', (reason) => {
    console.log('WhatsApp Client disconnected:', reason);
    isReady = false;
    io.emit('disconnected', reason);
    client.initialize(); // Try to reconnect immediately
});

client.initialize();

// --- API ROUTES ---

// Route 1: Get List of Groups
app.get('/api/groups', async (req, res) => {
    if (!isReady) {
        return res.status(503).json({ error: 'WhatsApp not ready yet. Please wait.' });
    }

    try {
        const chats = await client.getChats();
        // Filter only groups
        const groups = chats
            .filter(chat => chat.isGroup)
            .map(chat => ({
                name: chat.name,
                id: chat.id._serialized
            }));
        res.json(groups);
    } catch (error) {
        console.error('Error fetching groups:', error);
        res.status(500).json({ error: error.message });
    }
});

// Route 2: Schedule an Image
app.post('/api/schedule', upload.single('image'), (req, res) => {
    const { groupId, scheduleTime, uiId } = req.body;
    const file = req.file;

    if (!file || !groupId || !scheduleTime || !uiId) {
        return res.status(400).json({ error: 'Missing required data' });
    }

    // Calculate delay (Time in future - Time now)
    const targetTime = new Date(scheduleTime).getTime();
    const now = Date.now();
    const delay = targetTime - now;

    // If time is in the past, delete file and reject
    if (delay < 0) {
        fs.unlink(file.path, () => {});
        return res.status(400).json({ error: 'Scheduled time is in the past.' });
    }

    console.log(`Scheduling Task ${uiId} for ${delay}ms from now.`);

    // Set the Timer
    const timeoutId = setTimeout(async () => {
        try {
            // Check if file still exists
            if (fs.existsSync(file.path)) {
                // Read and Send Media
                const media = MessageMedia.fromFilePath(file.path);
                await client.sendMessage(groupId, media);
                
                // Notify Front End
                io.emit('message_sent', { id: uiId, status: 'Sent' });

                // Delete file to free space
                fs.unlink(file.path, () => {});
            }
            // Remove from tracking map
            scheduledTasks.delete(uiId);

        } catch (error) {
            console.error(`Failed to send ${uiId}:`, error);
        }
    }, delay);

    // Save task details so we can cancel it later
    scheduledTasks.set(uiId, {
        timeout: timeoutId,
        filePath: file.path
    });

    res.json({ status: 'Scheduled', id: uiId });
});

// Route 3: Cancel a Scheduled Image
app.post('/api/cancel', (req, res) => {
    const { id } = req.body;

    if (scheduledTasks.has(id)) {
        const task = scheduledTasks.get(id);

        // 1. Stop the Timer
        clearTimeout(task.timeout);

        // 2. Delete the File immediately
        if (fs.existsSync(task.filePath)) {
            fs.unlinkSync(task.filePath);
        }

        // 3. Remove from Map
        scheduledTasks.delete(id);

        return res.json({ status: 'Cancelled and Deleted' });
    }

    res.status(404).json({ error: 'Task ID not found or already sent' });
});

// --- START SERVER ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});