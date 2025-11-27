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

// --- CHIẾN THUẬT RETRY (Chia nhỏ để tăng tỉ lệ thành công) ---
const getInfoWithRetry = async (url) => {
	// Chia nhỏ từng Client ra để thử riêng biệt
	const strategies = [
		{
			name: "1. Android Strategy",
			options: { agent, playerClients: ["ANDROID"] },
		},
		{
			name: "2. iOS Strategy",
			options: { agent, playerClients: ["IOS"] },
		},
		{
			name: "3. Web Creator Strategy",
			options: { agent, playerClients: ["WEB_CREATOR"] },
		},
		{
			name: "4. TV Embedded (No Cookies)",
			// TV Embed thường là cứu cánh cuối cùng
			options: { agent: undefined, playerClients: ["TV_EMBEDDED"] },
		},
		{
			name: "5. Mweb (Mobile Web)",
			options: { agent, playerClients: ["MWEB"] },
		},
	];

	let lastError = null;

	for (const strategy of strategies) {
		try {
			console.log(`--> Đang thử: ${strategy.name}...`);
			const info = await ytdl.getInfo(url, strategy.options);
			return { info, strategy: strategy.name }; // Thành công!
		} catch (error) {
			console.log(
				`   [FAIL] ${strategy.name}: ${error.message.split("\n")[0]}`
			);
			lastError = error;
			if (error.message.includes("Video unavailable")) break; // Video die thật thì dừng
		}
	}
	throw (
		lastError ||
		new Error("Server quá tải hoặc bị YouTube chặn IP tạm thời.")
	);
};

const formatTime = (seconds) => {
	const m = Math.floor(seconds / 60);
	const s = Math.floor(seconds % 60);
	return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
};

// Health Check
app.get("/", (req, res) => {
	res.send("Server YT Downloader (Granular Strategy V3.0) is running!");
});

// API Info
app.get("/api/info", async (req, res) => {
	try {
		const { url } = req.query;
		if (!url || !ytdl.validateURL(url)) {
			return res.status(400).json({ error: "URL không hợp lệ" });
		}

		const { info, strategy } = await getInfoWithRetry(url);
		console.log(`--> [SUCCESS] Lấy info thành công bằng: ${strategy}`);

		const thumbnails = info.videoDetails.thumbnails;
		const thumbnail = thumbnails[thumbnails.length - 1].url;

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
				? "Server bị chặn (403). Vui lòng thử lại sau ít phút."
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

// --- API: Tải xuống (Dùng downloadFromInfo) ---
app.get("/api/download", async (req, res) => {
	try {
		const { url, type } = req.query;

		if (!url || !ytdl.validateURL(url)) {
			return res.status(400).send("URL không hợp lệ");
		}

		// Bước 1: Lấy Info "sạch" bằng chiến thuật
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
			// Video có tiếng (720p)
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

		// Bước 2: Tải xuống bằng chính object info vừa lấy được (Tránh bị chặn khi fetch lại)
		const videoStream = ytdl.downloadFromInfo(info, {
			format: format,
			highWaterMark: 1 << 22,
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
