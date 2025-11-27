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

// --- 2. CHIẾN THUẬT VÉT CẠN (BRUTE FORCE STRATEGIES) ---
const getStrategies = () => {
	const strategies = [];
	const hasCookies = fs.existsSync(COOKIES_FILE_PATH);

	const baseArgs = [
		"--no-warnings",
		"--no-check-certificates",
		"--prefer-free-formats",
		"--dump-single-json",
		"--force-ipv4", // Ép dùng IPv4 để ổn định hơn
	];

	const addStrat = (name, client, useCookies) => {
		const args = [...baseArgs];

		// Client spoofing
		if (client) {
			args.push("--extractor-args", `youtube:player_client=${client}`);
		}

		// Cookies (Luôn dùng nếu có, vì IP Render đã bị đen)
		if (useCookies && hasCookies) {
			args.push("--cookies", COOKIES_FILE_PATH);
		}

		strategies.push({
			name: `${name} ${useCookies ? "(Cookies)" : "(No Cookies)"}`,
			args,
		});
	};

	// --- NHÓM 1: WEB BROWSERS (Thường ít bị chặn nếu có Cookies xịn) ---
	if (hasCookies) {
		addStrat("1. Web Desktop", "web", true);
		addStrat("2. Mobile Web", "mweb", true);
	}

	// --- NHÓM 2: MOBILE APPS (Fake App để né bot check) ---
	if (hasCookies) {
		addStrat("3. Android", "android", true);
		addStrat("4. iOS", "ios", true);
	}

	// --- NHÓM 3: NO COOKIES (Dự phòng nếu Cookies lỗi) ---
	addStrat("5. Android (No Cookies)", "android", false);
	addStrat("6. iOS (No Cookies)", "ios", false);

	// --- NHÓM 4: OBSCURE CLIENTS (Ít người dùng nên ít bị chặn) ---
	addStrat("7. TV Embedded", "tv_embedded", false);
	addStrat("8. Android Creator", "android_creator", hasCookies);
	addStrat("9. Android Music", "android_music", hasCookies);

	return strategies;
};

// --- HELPER: RUN YT-DLP ---
const runYtDlp = (args) => {
	return new Promise((resolve, reject) => {
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

const wait = (ms) => new Promise((res) => setTimeout(res, ms));

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

			console.log(`    [SUCCESS] Strategy worked: ${strategy.name}`);
			return res.json(metadata);
		} catch (error) {
			lastError = error.message;
			// Nghỉ 200ms giữa các lần thử để tránh spam
			await wait(200);
		}
	}

	console.error("--> ALL STRATEGIES FAILED.");
	if (lastError && lastError.includes("Sign in")) {
		return res.status(403).json({
			error: "Server bị YouTube chặn (403). Cookies của bạn có thể đã hết hạn hoặc không khớp với IP Server.",
		});
	}
	res.status(500).json({
		error: "Không thể lấy thông tin video. Vui lòng thử lại sau.",
	});
});

// --- API DOWNLOAD ---
app.get("/api/download", async (req, res) => {
	const { url, type } = req.query;
	if (!url) return res.status(400).send("Thiếu URL");

	console.log(`--> [Download] ${url} [${type}]`);

	// Download Strategy: Thử dùng cấu hình Android + Cookies vì ổn định nhất cho stream
	const downloadArgs = [
		url,
		"-o",
		"-",
		"--extractor-args",
		"youtube:player_client=android",
		"--no-part",
		"--no-check-certificates",
		"--quiet",
		"--force-ipv4",
	];

	if (fs.existsSync(COOKIES_FILE_PATH)) {
		downloadArgs.push("--cookies", COOKIES_FILE_PATH);
	}

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

app.get("/", (req, res) =>
	res.send("Server yt-dlp Brute-Force Strategy is running!")
);

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
