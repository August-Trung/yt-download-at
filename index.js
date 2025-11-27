const express = require("express");
const cors = require("cors");
const ytdl = require("@distube/ytdl-core");
const ytpl = require("ytpl");
const fetch = require("node-fetch");
const app = express();

const PORT = process.env.PORT || 4000;

app.use(
	cors({
		origin: "*",
		methods: ["GET", "POST"],
	})
);

app.use(express.json());

// --- CẤU HÌNH AGENT ---
let agent;
try {
	const cookiesEnv = process.env.YOUTUBE_COOKIES;
	if (cookiesEnv) {
		const cookies = JSON.parse(cookiesEnv);
		// Quan trọng: Không set keepAlive để tránh lỗi crash trên Render
		agent = ytdl.createAgent(cookies);
		console.log(`--> [INFO] Đã load Cookies thành công!`);
	} else {
		console.log(
			"--> [WARN] Không tìm thấy YOUTUBE_COOKIES. Server sẽ chạy chế độ không đăng nhập."
		);
	}
} catch (error) {
	console.error("Lỗi parse Cookies:", error.message);
	agent = ytdl.createAgent();
}

// --- CHIẾN THUẬT RETRY (QUAN TRỌNG) ---
// Hàm này sẽ thử lần lượt các cách để lấy thông tin video
const getInfoWithRetry = async (url) => {
	const strategies = [
		{
			name: "Mobile Strategy (Android/iOS)",
			options: { agent, playerClients: ["ANDROID", "IOS"] },
		},
		{
			name: "Web Strategy",
			options: { agent, playerClients: ["WEB", "WEB_CREATOR"] },
		},
		{
			name: "TV Embedded Strategy (No Cookies)",
			// TV Embedded thường không cần cookies và ít bị Geo-block
			options: { agent: undefined, playerClients: ["TV_EMBEDDED"] },
		},
	];

	let lastError = null;

	for (const strategy of strategies) {
		try {
			console.log(`--> Thử chiến thuật: ${strategy.name}...`);
			const info = await ytdl.getInfo(url, strategy.options);
			return { info, strategy: strategy.name }; // Thành công trả về ngay
		} catch (error) {
			console.log(`   [FAIL] ${strategy.name}: ${error.message}`);
			lastError = error;
			// Nếu lỗi là do video không tồn tại thì dừng luôn
			if (error.message.includes("Video unavailable")) break;
		}
	}
	throw lastError || new Error("Mọi chiến thuật đều thất bại.");
};

const formatTime = (seconds) => {
	const m = Math.floor(seconds / 60);
	const s = Math.floor(seconds % 60);
	return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
};

// Health Check
app.get("/", (req, res) => {
	res.send("Server YT Downloader (Multi-Strategy V2.1) is running!");
});

// API Info
app.get("/api/info", async (req, res) => {
	try {
		const { url } = req.query;
		if (!url || !ytdl.validateURL(url)) {
			return res.status(400).json({ error: "URL không hợp lệ" });
		}

		const { info, strategy } = await getInfoWithRetry(url);
		console.log(`--> Thành công với: ${strategy}`);

		const thumbnails = info.videoDetails.thumbnails;
		const thumbnail = thumbnails[thumbnails.length - 1].url;

		// Xử lý Captions
		let scriptContent = "";
		try {
			const tracks =
				info.player_response.captions?.playerCaptionsTracklistRenderer
					?.captionTracks;
			if (tracks && tracks.length > 0) {
				const sortedTracks = tracks.sort((a, b) => {
					if (a.languageCode === "vi") return -1;
					if (b.languageCode === "vi") return 1;
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
					const text = match[2]
						.replace(/&amp;/g, "&")
						.replace(/&quot;/g, '"')
						.replace(/&#39;/g, "'");
					lines.push(`[${time}] ${text}`);
				}
				if (lines.length > 0) {
					scriptContent = lines.join("\n");
				}
			}
		} catch (e) {
			/* Ignore */
		}

		if (!scriptContent)
			scriptContent = "[Hệ thống] Video này không có phụ đề.";

		const metadata = {
			id: info.videoDetails.videoId,
			title: info.videoDetails.title,
			channel: info.videoDetails.author.name,
			views: parseInt(info.videoDetails.viewCount).toLocaleString(),
			description: info.videoDetails.description
				? info.videoDetails.description.substring(0, 200) + "..."
				: "",
			thumbnailUrl: thumbnail,
			duration: info.videoDetails.lengthSeconds,
			script: scriptContent,
		};

		res.json(metadata);
	} catch (error) {
		console.error("Final Error:", error.message);
		const status = error.message.includes("Sign in") ? 403 : 500;
		res.status(status).json({
			error: error.message.includes("Sign in")
				? "Server bị YouTube chặn hoàn toàn (403). Vui lòng cập nhật Cookies mới."
				: "Lỗi Server: " + error.message,
		});
	}
});

// API Playlist
app.get("/api/playlist", async (req, res) => {
	try {
		const { url } = req.query;
		if (!url) return res.status(400).json({ error: "Thiếu URL Playlist" });

		const playlistID = await ytpl.getPlaylistID(url);
		const playlist = await ytpl(playlistID, { limit: 20 });

		const videos = playlist.items.map((item) => ({
			id: item.id,
			title: item.title,
			channel: item.author.name,
			views: "Playlist",
			description: `Video trong playlist: ${playlist.title}`,
			thumbnailUrl: item.bestThumbnail.url,
			script: "",
		}));

		res.json(videos);
	} catch (error) {
		res.status(500).json({
			error: "Không thể lấy playlist. Link Mix (RD) không được hỗ trợ.",
		});
	}
});

// --- API: Tải xuống (Đã sửa logic) ---
app.get("/api/download", async (req, res) => {
	try {
		const { url, type } = req.query;

		if (!url || !ytdl.validateURL(url)) {
			return res.status(400).send("URL không hợp lệ");
		}

		// Bước 1: Lấy Info bằng chiến thuật tốt nhất
		// Chúng ta gọi lại getInfoWithRetry để đảm bảo lấy được info sạch trước khi tải
		const { info } = await getInfoWithRetry(url);

		const title = info.videoDetails.title.replace(
			/[^\w\s\u00C0-\u1EF9]/gi,
			""
		);

		let format;
		let contentType;
		let filename;

		if (type === "audio") {
			format = ytdl.chooseFormat(info.formats, {
				quality: "highestaudio",
			});
			contentType = "audio/mpeg";
			filename = `${title}.mp3`;
		} else if (type === "video_silent") {
			format = ytdl.chooseFormat(info.formats, {
				quality: "highestvideo",
			});
			contentType = "video/mp4";
			filename = `${title}_HighRes_NoAudio.mp4`;
		} else {
			// Lọc video có cả tiếng và hình (thường max 720p)
			format = ytdl.chooseFormat(info.formats, {
				quality: "highest",
				filter: "audioandvideo",
			});
			if (!format)
				format = ytdl.chooseFormat(info.formats, {
					quality: "highest",
				});
			contentType = "video/mp4";
			filename = `${title}.mp4`;
		}

		if (!format) {
			throw new Error("Không tìm thấy định dạng phù hợp.");
		}

		const encodedFilename = encodeURIComponent(filename);
		res.header(
			"Content-Disposition",
			`attachment; filename*=UTF-8''${encodedFilename}`
		);
		res.header("Content-Type", contentType);

		// Bước 2: Tải xuống TỪ INFO ĐÃ LẤY ĐƯỢC (downloadFromInfo)
		// Đây là điểm mấu chốt: Không dùng ytdl(url) vì nó sẽ tự fetch info lại bằng default agent và bị chặn.
		const videoStream = ytdl.downloadFromInfo(info, {
			format: format,
			highWaterMark: 1 << 22, // 4MB Buffer
		});

		videoStream.pipe(res);

		req.on("close", () => {
			videoStream.destroy();
		});
	} catch (error) {
		console.error("Download Error:", error.message);
		if (!res.headersSent) {
			res.status(500).send("Lỗi: " + error.message);
		}
	}
});

app.listen(PORT, () => {
	console.log(`Server đang chạy tại port ${PORT}`);
});
