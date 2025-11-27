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
	const hasCookies = fs.existsSync(COOKIES_FILE_PATH);

	// Base args common for all
	const baseArgs = [
		"--no-warnings",
		"--no-check-certificates",
		"--prefer-free-formats",
		"--dump-single-json",
	];

	// Helper to add strategy
	const addStrat = (name, client, useCookies) => {
		const args = [...baseArgs];

		// Client spoofing
		if (client) {
			args.push("--extractor-args", `youtube:player_client=${client}`);
		}

		// Cookies
		if (useCookies && hasCookies) {
			args.push("--cookies", COOKIES_FILE_PATH);
		}

		strategies.push({
			name: `${name} ${useCookies ? "(With Cookies)" : "(No Cookies)"}`,
			args,
		});
	};

	// --- ƯU TIÊN 1: COOKIES + MOBILE (Mạnh nhất để lách Geo-lock) ---
	if (hasCookies) {
		addStrat("Android", "android", true);
		addStrat("iOS", "ios", true);
		addStrat("Web Creator", "web_creator", true);
	}

	// --- ƯU TIÊN 2: MOBILE (NO COOKIES - Nếu cookies bị lỗi/hết hạn) ---
	addStrat("Android", "android", false);
	addStrat("iOS", "ios", false);

	// --- ƯU TIÊN 3: TV EMBEDDED (Thường không cần login) ---
	addStrat("TV Embedded", "tv_embedded", false);

	return strategies;
};

// --- HELPER: RUN YT-DLP ---
const runYtDlp = (args) => {
	return new Promise((resolve, reject) => {
		// Log command for debug (hide cookies path)
		// console.log("Running:", args.filter(a => !a.includes('cookies')).join(' '));

		const process = spawn(YTDLP_PATH, args);

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
		console.log(`    Trying: ${strategy.name}...`);
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

			console.log(`    [SUCCESS] ${strategy.name} worked!`);
			return res.json(metadata);
		} catch (error) {
			// console.log(`    [FAIL] Msg: ${error.message.substring(0, 100)}...`);
			lastError = error.message;
		}
	}

	console.error("--> ALL STRATEGIES FAILED.");
	if (lastError && lastError.includes("Sign in")) {
		return res.status(403).json({
			error: "Server bị YouTube chặn (403). Hãy thử cập nhật Cookies mới.",
		});
	}
	res.status(500).json({ error: "Không thể lấy thông tin video." });
});

// --- API DOWNLOAD ---
app.get("/api/download", async (req, res) => {
	const { url, type } = req.query;
	if (!url) return res.status(400).send("Thiếu URL");

	console.log(`--> [Download] ${url} [${type}]`);

	// Download Strategy: Use Android + Cookies (Best chance)
	const downloadArgs = [
		url,
		"-o",
		"-",
		"--extractor-args",
		"youtube:player_client=android",
		"--no-part",
		"--no-check-certificates",
		"--quiet",
	];

	if (fs.existsSync(COOKIES_FILE_PATH)) {
		downloadArgs.push("--cookies", COOKIES_FILE_PATH);
	}

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

	res.header(
		"Content-Disposition",
		`attachment; filename="video_download.${
			type === "audio" ? "mp3" : "mp4"
		}"`
	);

	const subprocess = spawn(YTDLP_PATH, downloadArgs);
	subprocess.stdout.pipe(res);

	// Log error but don't crash
	subprocess.stderr.on("data", (d) =>
		console.error(`DL Error: ${d.toString()}`)
	);

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

app.get("/", (req, res) => res.send("Server yt-dlp Auto-Strategy is running!"));

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
