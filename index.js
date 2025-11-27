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

const YTDLP_PATH = path.join(__dirname, "yt-dlp");
const COOKIES_FILE_PATH = path.join(__dirname, "cookies.txt");

// --- 1. SETUP COOKIES ---
const convertJsonToNetscape = (jsonCookies) => {
	let netscapeContent = "# Netscape HTTP Cookie File\n\n";
	try {
		const cookies =
			typeof jsonCookies === "string"
				? JSON.parse(jsonCookies)
				: jsonCookies;
		if (!Array.isArray(cookies)) return null;
		cookies.forEach((c) => {
			const domain = c.domain || ".youtube.com";
			const flag = domain.startsWith(".") ? "TRUE" : "FALSE";
			const path = c.path || "/";
			const secure = c.secure ? "TRUE" : "FALSE";
			const expiration = c.expirationDate
				? Math.round(c.expirationDate)
				: 0;
			netscapeContent += `${domain}\t${flag}\t${path}\t${secure}\t${expiration}\t${c.name}\t${c.value}\n`;
		});
		return netscapeContent;
	} catch (e) {
		return null;
	}
};

if (process.env.YOUTUBE_COOKIES) {
	const data = convertJsonToNetscape(process.env.YOUTUBE_COOKIES);
	if (data) fs.writeFileSync(COOKIES_FILE_PATH, data);
}

// --- 2. CHIẾN THUẬT (STRATEGIES) ---
const getStrategies = () => {
	const strategies = [];

	// Strategy 1: Cookies (Nếu có)
	if (fs.existsSync(COOKIES_FILE_PATH)) {
		strategies.push({
			name: "Cookies + Desktop",
			args: [
				"--cookies",
				COOKIES_FILE_PATH,
				"--user-agent",
				"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
			],
		});
	}

	// Strategy 2: Android (No Cookies - Bypass Geo-lock)
	strategies.push({
		name: "Android Client",
		args: [
			"--extractor-args",
			"youtube:player_client=android",
			"--user-agent",
			"Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
		],
	});

	// Strategy 3: iOS (No Cookies)
	strategies.push({
		name: "iOS Client",
		args: [
			"--extractor-args",
			"youtube:player_client=ios",
			"--user-agent",
			"Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
		],
	});

	// Strategy 4: TV Embedded (No Cookies - Ultimate Fallback)
	strategies.push({
		name: "TV Embedded",
		args: [
			"--extractor-args",
			"youtube:player_client=tv_embedded",
			"--user-agent",
			"Mozilla/5.0 (SMART-TV; LINUX; Tizen 5.0) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/2.2 Chrome/63.0.3239.84 TV Safari/537.36",
		],
	});

	return strategies;
};

// --- HELPER: RUN YT-DLP ---
const runYtDlp = (args) => {
	return new Promise((resolve, reject) => {
		const process = spawn(YTDLP_PATH, [
			...args,
			"--no-warnings",
			"--no-check-certificates",
			"--prefer-free-formats",
			"--dump-single-json",
		]);

		let stdout = "";
		let stderr = "";
		process.stdout.on("data", (d) => (stdout += d.toString()));
		process.stderr.on("data", (d) => (stderr += d.toString()));

		process.on("close", (code) => {
			if (code === 0) {
				try {
					resolve(JSON.parse(stdout));
				} catch (e) {
					reject(new Error("JSON Parse Error"));
				}
			} else {
				reject(new Error(stderr || "Unknown Error"));
			}
		});
	});
};

// --- API INFO (LOOP STRATEGIES) ---
app.get("/api/info", async (req, res) => {
	const { url } = req.query;
	if (!url) return res.status(400).json({ error: "Thiếu URL" });

	console.log(`\n--> [Info Request] ${url}`);
	const strategies = getStrategies();
	let lastError = null;

	for (const strategy of strategies) {
		console.log(`    Trying strategy: ${strategy.name}...`);
		try {
			const output = await runYtDlp([url, ...strategy.args]);

			// Success!
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
				script: output.description || "Không có mô tả.",
			};

			console.log(`    [SUCCESS] Strategy ${strategy.name} worked!`);
			return res.json(metadata);
		} catch (error) {
			console.log(
				`    [FAIL] ${strategy.name}: ${error.message.split("\n")[0]}`
			);
			lastError = error.message;
			// Continue to next strategy
		}
	}

	console.error("--> ALL STRATEGIES FAILED.");
	if (lastError && lastError.includes("Sign in")) {
		return res.status(403).json({
			error: "Tất cả chiến thuật thất bại (Geo-lock). Hãy thử lại sau.",
		});
	}
	res.status(500).json({ error: "Không thể lấy thông tin video." });
});

// --- API DOWNLOAD ---
app.get("/api/download", async (req, res) => {
	const { url, type } = req.query;
	if (!url) return res.status(400).send("Thiếu URL");

	console.log(`--> [Download] ${url} [${type}]`);

	// Mặc định dùng Android Client cho Download để ổn định nhất (kể cả khi không có cookies)
	const downloadArgs = [
		url,
		"-o",
		"-",
		"--extractor-args",
		"youtube:player_client=android",
		"--user-agent",
		"Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
		"--no-part",
		"--no-check-certificates",
		"--quiet",
	];

	// Định dạng
	if (type === "audio") {
		downloadArgs.push("-f", "bestaudio/best");
		res.header("Content-Type", "audio/mpeg");
	} else if (type === "video_silent") {
		downloadArgs.push("-f", "bestvideo");
		res.header("Content-Type", "video/mp4");
	} else {
		downloadArgs.push("-f", "best[height<=720]");
		res.header("Content-Type", "video/mp4");
	}

	// Set Header
	res.header(
		"Content-Disposition",
		`attachment; filename="video_download.${
			type === "audio" ? "mp3" : "mp4"
		}"`
	);

	const subprocess = spawn(YTDLP_PATH, downloadArgs);
	subprocess.stdout.pipe(res);

	req.on("close", () => subprocess.kill());
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

app.get("/", (req, res) =>
	res.send("Server yt-dlp Multi-Strategy is running!")
);

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
