const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const app = express();

const PORT = process.env.PORT || 4000;

// API Key cho Cobalt (Tùy chọn - lấy từ https://cobalt.tools)
const COBALT_API_KEY = process.env.COBALT_API_KEY || "";

app.use(cors({ origin: "*", methods: ["GET", "POST"] }));
app.use(express.json());

// --- DANH SÁCH SERVER COBALT ---
const COBALT_INSTANCES = [
	"https://co.wuk.sh", // Instance công khai chính (KHÔNG có /api/json)
	"https://api.cobalt.tools", // Instance chính thức (cần API key)
];

// Helper: Gọi API Cobalt với cơ chế Retry
const fetchFromCobalt = async (url, config = {}) => {
	let lastError = null;

	for (const instance of COBALT_INSTANCES) {
		try {
			console.log(`--> [Cobalt] Đang thử server: ${instance}`);

			// Cấu trúc request theo Cobalt API v9/v10 chính thức
			const requestBody = {
				url: url,
				videoQuality: config.videoQuality || "1080", // "144" | "240" | "360" | "480" | "720" | "1080" | "1440" | "2160" | "4320" | "max"
				audioFormat: config.audioFormat || "mp3", // "best" | "mp3" | "ogg" | "wav" | "opus"
				filenameStyle: "classic", // "classic" | "basic" | "pretty" | "nerdy"
				isAudioOnly: config.isAudioOnly || false,
			};

			console.log(
				`    [Request Body]:`,
				JSON.stringify(requestBody, null, 2)
			);

			const headers = {
				Accept: "application/json",
				"Content-Type": "application/json",
			};

			// Thêm API key nếu có
			if (COBALT_API_KEY) {
				headers.Authorization = `Api-Key ${COBALT_API_KEY}`;
			}

			// QUAN TRỌNG: Endpoint là "/" không phải "/api/json"
			const response = await fetch(`${instance}/`, {
				method: "POST",
				headers: headers,
				body: JSON.stringify(requestBody),
			});

			console.log(`    [Response Status]: ${response.status}`);

			if (!response.ok) {
				const errorText = await response.text();
				console.warn(
					`   [Skip] ${instance} HTTP ${
						response.status
					}: ${errorText.substring(0, 300)}`
				);
				lastError = `HTTP ${response.status}`;
				continue;
			}

			const data = await response.json();
			console.log(`    [Response Data]:`, JSON.stringify(data, null, 2));

			// Xử lý các loại response
			if (data.status === "error" || data.status === "rate-limit") {
				console.warn(
					`   [Skip] ${instance} lỗi: ${data.text || "Unknown"}`
				);
				lastError = data.text || "Unknown error";
				continue;
			}

			// Success cases
			if (
				data.status === "redirect" ||
				data.status === "stream" ||
				data.status === "success"
			) {
				return data;
			}

			// Picker case (nhiều lựa chọn)
			if (data.status === "picker") {
				return data;
			}

			throw new Error(`Unexpected response status: ${data.status}`);
		} catch (e) {
			console.warn(`   [Skip] ${instance} không phản hồi: ${e.message}`);
			lastError = e.message;
		}
	}

	throw new Error(
		lastError || "Tất cả server Cobalt đều đang bận. Vui lòng thử lại sau."
	);
};

// --- API INFO ---
app.get("/api/info", async (req, res) => {
	const { url } = req.query;
	if (!url) return res.status(400).json({ error: "Thiếu URL" });

	console.log(`\n[INFO REQUEST] URL: ${url}`);

	try {
		// Gọi Cobalt để kiểm tra video
		const result = await fetchFromCobalt(url, {
			videoQuality: "1080",
			isAudioOnly: false,
		});

		// Lấy video ID từ URL YouTube
		let videoId = "unknown";
		let thumbnailUrl = "https://i.ytimg.com/vi/mqdefault.jpg";

		const regExp =
			/^.*((youtu.be\/)|(v\/)|(\/u\/\w\/)|(embed\/)|(watch\?))\??v?=?([^#&?]*).*/;
		const match = url.match(regExp);
		if (match && match[7] && match[7].length === 11) {
			videoId = match[7];
			thumbnailUrl = `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`;
		}

		const metadata = {
			id: videoId,
			title: result.filename || "Video YouTube",
			channel: "YouTube Channel",
			views: "---",
			description: "Video đã sẵn sàng tải xuống (Powered by Cobalt API).",
			thumbnailUrl: thumbnailUrl,
			script: "",
		};

		console.log(`[INFO SUCCESS] Video ID: ${videoId}`);
		res.json(metadata);
	} catch (error) {
		console.error("[INFO ERROR]:", error.message);
		res.status(500).json({
			error: "Không thể lấy thông tin video.",
			details: error.message,
		});
	}
});

// --- API DOWNLOAD ---
app.get("/api/download", async (req, res) => {
	const { url, type } = req.query;
	if (!url) return res.status(400).send("Thiếu URL");

	console.log(`\n[DOWNLOAD REQUEST] URL: ${url}, Type: ${type}`);

	try {
		let cobaltConfig = {};

		// Cấu hình theo loại download
		if (type === "audio") {
			cobaltConfig = {
				audioFormat: "mp3",
				isAudioOnly: true,
			};
		} else if (type === "video_silent") {
			cobaltConfig = {
				videoQuality: "max",
				isAudioOnly: false,
			};
		} else {
			// Video Full HD mặc định
			cobaltConfig = {
				videoQuality: "1080",
				isAudioOnly: false,
			};
		}

		const result = await fetchFromCobalt(url, cobaltConfig);

		console.log(`[DOWNLOAD RESULT]:`, result.status);

		// Xử lý response theo status
		if (result.status === "redirect" && result.url) {
			console.log(`[REDIRECT] → ${result.url}`);
			return res.redirect(result.url);
		}

		if (result.status === "stream" && result.url) {
			console.log(`[STREAM] → ${result.url}`);
			return res.redirect(result.url);
		}

		if (
			result.status === "picker" &&
			result.picker &&
			result.picker.length > 0
		) {
			console.log(
				`[PICKER] Using first option → ${result.picker[0].url}`
			);
			return res.redirect(result.picker[0].url);
		}

		throw new Error("Không tìm thấy link download");
	} catch (error) {
		console.error("[DOWNLOAD ERROR]:", error.message);
		res.status(500).send(`Lỗi tải xuống: ${error.message}`);
	}
});

// --- API PLAYLIST ---
app.get("/api/playlist", (req, res) => {
	console.log("\n[PLAYLIST REQUEST] - Not supported");
	res.status(501).json({
		error: "Tính năng tải Playlist chưa được hỗ trợ.",
		message: "Vui lòng tải từng video riêng lẻ.",
	});
});

// --- Health Check ---
app.get("/", (req, res) => {
	res.json({
		status: "online",
		message: "Cobalt Proxy Backend is Running!",
		endpoints: {
			info: "/api/info?url=VIDEO_URL",
			download:
				"/api/download?url=VIDEO_URL&type=video|audio|video_silent",
			playlist: "/api/playlist (not supported)",
		},
		cobaltInstances: COBALT_INSTANCES,
		hasApiKey: !!COBALT_API_KEY,
		version: "2.1",
	});
});

// --- Khởi động server ---
app.listen(PORT, () => {
	console.log("=".repeat(60));
	console.log(`🚀 Cobalt Proxy Backend v2.1`);
	console.log(`📍 Port: ${PORT}`);
	console.log(`🔗 API: http://localhost:${PORT}`);
	console.log(
		`🔑 API Key: ${
			COBALT_API_KEY
				? "✅ Configured"
				: "❌ Not set (using public instances)"
		}`
	);
	console.log(`🌐 Instances: ${COBALT_INSTANCES.join(", ")}`);
	console.log("=".repeat(60));
});
