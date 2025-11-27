const express = require("express");
const cors = require("cors");
const ytDlp = require("youtube-dl-exec");
const ytpl = require("ytpl");
const app = express();
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 4000;

app.use(cors({ origin: "*", methods: ["GET", "POST"] }));
app.use(express.json());

// --- XỬ LÝ COOKIES (NẾU CÓ) ---
const COOKIES_FILE_PATH = path.join(__dirname, "cookies.txt");

// Helper function để ghi cookies ra file nếu có biến môi trường
const setupCookies = () => {
	// Nếu có biến môi trường dạng JSON (Render), ta ưu tiên dùng
	// Nhưng yt-dlp cần Netscape format.
	// Tạm thời chỉ log, nếu người dùng setup file cookies.txt thông qua biến ENV thì ghi ra.
	if (process.env.YOUTUBE_COOKIES_TXT) {
		fs.writeFileSync(COOKIES_FILE_PATH, process.env.YOUTUBE_COOKIES_TXT);
		console.log("--> [INFO] Đã tạo file cookies.txt từ biến môi trường.");
		return true;
	}
	return false;
};
const hasCookies = setupCookies();

// --- API INFO ---
app.get("/api/info", async (req, res) => {
	const { url } = req.query;
	if (!url) return res.status(400).json({ error: "Thiếu URL" });

	console.log(`--> [yt-dlp] Lấy info: ${url}`);

	try {
		const flags = {
			dumpSingleJson: true,
			noWarnings: true,
			noCallHome: true,
			preferFreeFormats: true,
			youtubeSkipDashManifest: true,
			userAgent:
				"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
		};

		if (hasCookies || fs.existsSync(COOKIES_FILE_PATH)) {
			flags.cookies = COOKIES_FILE_PATH;
		}

		const output = await ytDlp(url, flags);

		// Xử lý Script/Description
		let scriptContent = "";
		if (output.description) {
			scriptContent = output.description;
		}

		const metadata = {
			id: output.id,
			title: output.title,
			channel: output.uploader,
			views: output.view_count
				? output.view_count.toLocaleString()
				: "N/A",
			description: output.description
				? output.description.substring(0, 200) + "..."
				: "",
			thumbnailUrl: output.thumbnail,
			duration: output.duration,
			script: scriptContent || "Không có mô tả chi tiết.",
		};

		res.json(metadata);
	} catch (error) {
		console.error("yt-dlp Info Error:", error.message);
		res.status(500).json({
			error: "Không thể lấy thông tin video. Server quá tải hoặc YouTube chặn IP.",
		});
	}
});

// --- API PLAYLIST ---
app.get("/api/playlist", async (req, res) => {
	try {
		const { url } = req.query;
		if (!url) return res.status(400).json({ error: "Thiếu URL" });

		const playlistID = await ytpl.getPlaylistID(url);
		const playlist = await ytpl(playlistID, { limit: 20 });
		const videos = playlist.items.map((item) => ({
			id: item.id,
			title: item.title,
			channel: item.author.name,
			views: "Playlist",
			description: `Playlist: ${playlist.title}`,
			thumbnailUrl: item.bestThumbnail.url,
			script: "",
		}));
		res.json(videos);
	} catch (error) {
		console.error("Playlist Error:", error.message);
		res.status(500).json({
			error: "Lỗi lấy Playlist. Link có thể không công khai.",
		});
	}
});

// --- API DOWNLOAD ---
app.get("/api/download", async (req, res) => {
	const { url, type } = req.query;
	if (!url) return res.status(400).send("Thiếu URL");

	console.log(`--> [yt-dlp] Tải xuống: ${url} [${type}]`);

	try {
		let format = "best";
		let contentType = "video/mp4";

		if (type === "audio") {
			format = "bestaudio/best";
			contentType = "audio/mpeg";
		} else if (type === "video_silent") {
			format = "bestvideo";
			contentType = "video/mp4";
		} else {
			format = "best[height<=720]";
			contentType = "video/mp4";
		}

		const info = await ytDlp(url, {
			dumpSingleJson: true,
			noWarnings: true,
			flatPlaylist: true,
		});
		const title = (info.title || "video").replace(
			/[^\w\s\u00C0-\u1EF9]/gi,
			""
		);
		const ext = type === "audio" ? "mp3" : "mp4";
		const filename = `${title}.${ext}`;

		res.header(
			"Content-Disposition",
			`attachment; filename*=UTF-8''${encodeURIComponent(filename)}`
		);
		res.header("Content-Type", contentType);

		const args = {
			output: "-",
			format: format,
			noPart: true,
			noCallHome: true,
			noCheckCertificates: true,
			quiet: true,
		};

		if (hasCookies || fs.existsSync(COOKIES_FILE_PATH)) {
			args.cookies = COOKIES_FILE_PATH;
		}

		const subprocess = ytDlp.exec(url, args);

		subprocess.stdout.pipe(res);

		subprocess.stderr.on("data", (data) => {
			console.error(`[yt-dlp stderr]: ${data}`);
		});

		req.on("close", () => {
			subprocess.kill();
		});
	} catch (error) {
		console.error("Download Error:", error);
		if (!res.headersSent) res.status(500).send("Lỗi Server khi tải xuống.");
	}
});

app.get("/", (req, res) => {
	res.send("Server yt-dlp Downloader is running!");
});

app.listen(PORT, () => {
	console.log(`Server yt-dlp đang chạy tại port ${PORT}`);
});
