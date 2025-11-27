const express = require("express");
const cors = require("cors");
const { spawn } = require("child_process");
const ytpl = require("ytpl");
const app = express();
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 4000;

app.use(cors({ origin: "*", methods: ["GET", "POST"] }));
app.use(express.json());

// Đường dẫn đến file binary yt-dlp đã tải về
const YTDLP_PATH = path.join(__dirname, "yt-dlp");

// Helper: Chạy lệnh yt-dlp và lấy kết quả JSON
const runYtDlpInfo = (url, flags = []) => {
	return new Promise((resolve, reject) => {
		// Mặc định thêm các cờ để output JSON
		const args = [
			url,
			"--dump-single-json",
			"--no-warnings",
			"--no-call-home",
			"--no-check-certificates",
			"--prefer-free-formats",
			...flags,
		];

		const process = spawn(YTDLP_PATH, args);

		let stdout = "";
		let stderr = "";

		process.stdout.on("data", (data) => {
			stdout += data.toString();
		});

		process.stderr.on("data", (data) => {
			stderr += data.toString();
		});

		process.on("close", (code) => {
			if (code === 0) {
				try {
					const json = JSON.parse(stdout);
					resolve(json);
				} catch (e) {
					reject(new Error("Failed to parse JSON output"));
				}
			} else {
				reject(new Error(stderr || "yt-dlp exited with error"));
			}
		});
	});
};

// --- XỬ LÝ COOKIES ---
const COOKIES_FILE_PATH = path.join(__dirname, "cookies.txt");
const setupCookies = () => {
	if (process.env.YOUTUBE_COOKIES_TXT) {
		fs.writeFileSync(COOKIES_FILE_PATH, process.env.YOUTUBE_COOKIES_TXT);
		return true;
	}
	return false;
};
const hasCookies = setupCookies();

// --- API INFO ---
app.get("/api/info", async (req, res) => {
	const { url } = req.query;
	if (!url) return res.status(400).json({ error: "Thiếu URL" });

	console.log(`--> [yt-dlp-native] Lấy info: ${url}`);

	try {
		const flags = [];
		if (hasCookies || fs.existsSync(COOKIES_FILE_PATH)) {
			flags.push("--cookies", COOKIES_FILE_PATH);
		}

		const output = await runYtDlpInfo(url, flags);

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
		res.status(500).json({ error: "Lỗi lấy Playlist." });
	}
});

// --- API DOWNLOAD ---
app.get("/api/download", async (req, res) => {
	const { url, type } = req.query;
	if (!url) return res.status(400).send("Thiếu URL");

	console.log(`--> [yt-dlp-native] Tải xuống: ${url} [${type}]`);

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

		// Lấy tên file trước
		let title = "video";
		try {
			const info = await runYtDlpInfo(url, ["--flat-playlist"]);
			title = (info.title || "video").replace(
				/[^\w\s\u00C0-\u1EF9]/gi,
				""
			);
		} catch (e) {}

		const ext = type === "audio" ? "mp3" : "mp4";
		const filename = `${title}.${ext}`;

		res.header(
			"Content-Disposition",
			`attachment; filename*=UTF-8''${encodeURIComponent(filename)}`
		);
		res.header("Content-Type", contentType);

		const args = [
			url,
			"-o",
			"-", // Output ra stdout
			"-f",
			format,
			"--no-part",
			"--no-call-home",
			"--no-check-certificates",
			"--quiet",
		];

		if (hasCookies || fs.existsSync(COOKIES_FILE_PATH)) {
			args.push("--cookies", COOKIES_FILE_PATH);
		}

		const subprocess = spawn(YTDLP_PATH, args);

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
	res.send("Server yt-dlp Native is running!");
});

app.listen(PORT, () => {
	console.log(`Server đang chạy tại port ${PORT}`);
});
