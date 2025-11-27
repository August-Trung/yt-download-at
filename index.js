
const express = require('express');
const cors = require('cors');
const ytdl = require('@distube/ytdl-core');
const ytpl = require('ytpl');
const fetch = require('node-fetch');
const app = express();

const PORT = process.env.PORT || 4000;

// Cấu hình CORS
app.use(cors({
    origin: '*', 
    methods: ['GET', 'POST']
}));

app.use(express.json());

// --- CẤU HÌNH AGENT (QUAN TRỌNG ĐỂ VƯỢT CHECK BOT) ---
// Render IP thường bị YouTube chặn. Cách duy nhất để fix triệt để là dùng Cookies.
// Bạn cần lấy cookies từ trình duyệt (dùng extension "Get cookies.txt LOCALLY")
// và lưu vào biến môi trường 'YOUTUBE_COOKIES' trên Render dưới dạng JSON array.

let agent;
try {
    const cookiesEnv = process.env.YOUTUBE_COOKIES;
    if (cookiesEnv) {
        const cookies = JSON.parse(cookiesEnv);
        agent = ytdl.createAgent(cookies);
        console.log("Đã khởi tạo Agent với Cookies!");
    } else {
        // Fallback: Tạo agent mặc định (đôi khi vẫn bị chặn nếu không có cookies thật)
        agent = ytdl.createAgent(); 
        console.log("Đang chạy Agent mặc định (Khuyên dùng Cookies để tránh lỗi 403)");
    }
} catch (error) {
    console.error("Lỗi khởi tạo Cookies:", error.message);
    agent = ytdl.createAgent();
}

const formatTime = (seconds) => {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
};

// Health Check
app.get('/', (req, res) => {
    res.send('Server YT Downloader is running normally!');
});

// API Info
app.get('/api/info', async (req, res) => {
    try {
        const { url } = req.query;
        if (!url || !ytdl.validateURL(url)) {
            return res.status(400).json({ error: 'URL không hợp lệ' });
        }

        // Dùng agent để vượt qua check bot
        const info = await ytdl.getInfo(url, { agent });
        
        const thumbnails = info.videoDetails.thumbnails;
        const thumbnail = thumbnails[thumbnails.length - 1].url;

        let scriptContent = "[Hệ thống] Video này không có phụ đề chi tiết hoặc phụ đề tự động.";
        try {
            const tracks = info.player_response.captions?.playerCaptionsTracklistRenderer?.captionTracks;
            if (tracks && tracks.length > 0) {
                const sortedTracks = tracks.sort((a, b) => {
                    if (a.languageCode === 'vi') return -1;
                    if (b.languageCode === 'vi') return 1;
                    return 0;
                });
                const captionUrl = sortedTracks[0].baseUrl;
                const captionRes = await fetch(captionUrl);
                const xmlText = await captionRes.text();
                const regex = /<text start="([\d.]+)"[^>]*>([^<]+)<\/text>/g;
                let match;
                let lines = [];
                while ((match = regex.exec(xmlText)) !== null) {
                    const time = formatTime(parseFloat(match[1]));
                    const text = match[2].replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
                    lines.push(`[${time}] ${text}`);
                }
                if (lines.length > 0) {
                    scriptContent = lines.join('\n');
                }
            }
        } catch (e) {
            console.log("Error fetching caption:", e.message);
        }

        const metadata = {
            id: info.videoDetails.videoId,
            title: info.videoDetails.title,
            channel: info.videoDetails.author.name,
            views: parseInt(info.videoDetails.viewCount).toLocaleString(),
            description: info.videoDetails.description ? info.videoDetails.description.substring(0, 200) + '...' : '',
            thumbnailUrl: thumbnail,
            duration: info.videoDetails.lengthSeconds,
            script: scriptContent
        };

        res.json(metadata);
    } catch (error) {
        console.error('Error fetching info:', error);
        if (error.message.includes('Sign in')) {
             return res.status(403).json({ error: 'Server bị YouTube chặn (403). Cần cập nhật Cookies mới cho Server.' });
        }
        res.status(500).json({ error: 'Không thể lấy thông tin. Video có thể bị giới hạn độ tuổi hoặc riêng tư.' });
    }
});

// API Playlist
app.get('/api/playlist', async (req, res) => {
    try {
        const { url } = req.query;
        if (!url) return res.status(400).json({ error: 'Thiếu URL Playlist' });

        // Agent cho ytpl (nếu thư viện hỗ trợ, hiện tại ytpl dùng request riêng nhưng ta cứ xử lý lỗi)
        const playlistID = await ytpl.getPlaylistID(url);
        const playlist = await ytpl(playlistID, { limit: 20 });

        const videos = playlist.items.map(item => ({
            id: item.id,
            title: item.title,
            channel: item.author.name,
            views: "Playlist",
            description: `Video trong playlist: ${playlist.title}`,
            thumbnailUrl: item.bestThumbnail.url,
            script: ""
        }));

        res.json(videos);
    } catch (error) {
        console.error('Playlist Error:', error);
        res.status(500).json({ error: 'Không thể lấy playlist. Có thể do link Mix (không hỗ trợ) hoặc Private.' });
    }
});

// --- API: Tải xuống ---
app.get('/api/download', async (req, res) => {
    try {
        const { url, type } = req.query; 
        
        if (!url || !ytdl.validateURL(url)) {
            return res.status(400).send('URL không hợp lệ');
        }

        // Dùng agent
        const info = await ytdl.getInfo(url, { agent });
        const title = info.videoDetails.title.replace(/[^\w\s\u00C0-\u1EF9]/gi, '');

        let format;
        let contentType;
        let filename;

        if (type === 'audio') {
            format = ytdl.chooseFormat(info.formats, { quality: 'highestaudio' });
            contentType = 'audio/mpeg';
            filename = `${title}.mp3`;
        } else if (type === 'video_silent') {
            format = ytdl.chooseFormat(info.formats, { quality: 'highestvideo' });
            contentType = 'video/mp4';
            filename = `${title}_HighRes_NoAudio.mp4`;
        } else {
            format = ytdl.chooseFormat(info.formats, { quality: 'highest' });
            contentType = 'video/mp4';
            filename = `${title}.mp4`;
        }

        const encodedFilename = encodeURIComponent(filename);
        res.header('Content-Disposition', `attachment; filename*=UTF-8''${encodedFilename}`);
        res.header('Content-Type', contentType);

        const videoStream = ytdl(url, { 
            format: format,
            highWaterMark: 1 << 22,
            agent: agent // QUAN TRỌNG
        });

        videoStream.pipe(res);

        res.on('close', () => {
            videoStream.destroy();
        });

    } catch (error) {
        console.error('Download Error:', error);
        if (!res.headersSent) {
            res.status(500).send('Lỗi Server khi tải video (Có thể do YouTube chặn IP).');
        }
    }
});

app.listen(PORT, () => {
    console.log(`Server đang chạy tại port ${PORT}`);
});
