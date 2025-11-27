const express = require("express");
const cors = require("cors");
const ytdl = require("@distube/ytdl-core");
const ytpl = require("ytpl");
const fetch = require("node-fetch");
const app = express();

const PORT = process.env.PORT || 4000;

// Cấu hình CORS mở rộng
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
		// Tạo agent với cấu hình giữ kết nối để giả lập hành vi người dùng thật
		agent = ytdl.createAgent(cookies, {
			keepAlive: true,
			keepAliveMsecs: 500,
		});
		console.log(`--> [INFO] Đã load ${cookies.length} Cookies thành công!`);
	} else {
		agent = ytdl.createAgent();
		console.log("--> [WARN] Không tìm thấy YOUTUBE_COOKIES.");
	}
} catch (error) {
	console.error("Lỗi parse Cookies:", error.message);
	agent = ytdl.createAgent();
}

const formatTime = (seconds) => {
	const m = Math.floor(seconds / 60);
	const s = Math.floor(seconds % 60);
	return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
};

// Health Check
app.get("/", (req, res) => {
	res.send("Server YT Downloader (Mobile Strategy) is running!");
});

// API Info
app.get("/api/info", async (req, res) => {
	try {
		const { url } = req.query;
		if (!url || !ytdl.validateURL(url)) {
			return res.status(400).json({ error: "URL không hợp lệ" });
		}

		console.log(`--> Đang lấy info cho: ${url}`);

		// CHIẾN THUẬT MOBILE:
		// Chỉ dùng 'IOS' và 'ANDROID'. Tuyệt đối KHÔNG dùng 'WEB' vì IP Render dễ bị chặn.
		const info = await ytdl.getInfo(url, {
			agent,
			playerClients: ["IOS", "ANDROID"],
		});

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
			// Ignore caption errors
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
		console.error("Error fetching info:", error.message);

		// Trả về lỗi chi tiết để debug
		if (error.message.includes("Sign in") || error.status === 403) {
			return res.status(403).json({
				error: "YouTube chặn IP Server (Geo-lock). Hãy thử lại sau hoặc đổi Cookies.",
			});
		}

		res.status(500).json({ error: "Lỗi Server: " + error.message });
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
		console.error("Playlist Error:", error.message);
		res.status(500).json({ error: "Không thể lấy playlist." });
	}
});

// --- API: Tải xuống ---
app.get("/api/download", async (req, res) => {
	try {
		const { url, type } = req.query;

		if (!url || !ytdl.validateURL(url)) {
			return res.status(400).send("URL không hợp lệ");
		}

		// Dùng IOS Client cho việc tải xuống
		const info = await ytdl.getInfo(url, {
			agent,
			playerClients: ["IOS", "ANDROID"],
		});

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
			// Với IOS Client, đôi khi 'highest' trả về định dạng m3u8 (livestream).
			// Ta cần lọc định dạng có container là mp4.
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

		const videoStream = ytdl(url, {
			format: format,
			highWaterMark: 1 << 22,
			agent: agent,
			playerClients: ["IOS", "ANDROID"],
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
