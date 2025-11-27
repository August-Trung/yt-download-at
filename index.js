const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const app = express();

const PORT = process.env.PORT || 4000;

app.use(cors({ origin: "*", methods: ["GET", "POST"] }));
app.use(express.json());

// --- DANH SÁCH SERVER COBALT (Đã cập nhật 2024) ---
const COBALT_INSTANCES = [
	"https://api.cobalt.tools", // Instance chính thức
];

// Helper: Gọi API Cobalt với cơ chế Retry
const fetchFromCobalt = async (url, config = {}) => {
	let lastError = null;

	for (const instance of COBALT_INSTANCES) {
		try {
			console.log(`--> [Cobalt] Đang thử server: ${instance}`);

			const requestBody = {
				url: url,
				videoQuality: config.videoQuality || "1080",
				audioFormat: config.audioFormat || "mp3",
				filenameStyle: "basic",
				downloadMode: config.downloadMode || "auto",
			};

			console.log(
				`    [Request Body]:`,
				JSON.stringify(requestBody, null, 2)
			);

			const response = await fetch(`${instance}/`, {
				method: "POST",
				headers: {
					Accept: "application/json",
					"Content-Type": "application/json",
					"User-Agent": "Mozilla/5.0 (compatible; CobaltProxy/1.0)",
				},
				body: JSON.stringify(requestBody),
			});

			console.log(`    [Response Status]: ${response.status}`);

			// Nếu server trả về lỗi
			if (!response.ok) {
				const errorText = await response.text();
				console.warn(
					`   [Skip] ${instance} HTTP ${
						response.status
					}: ${errorText.substring(0, 200)}`
				);
				lastError = `HTTP ${response.status}`;
				continue;
			}

			const data = await response.json();
			console.log(`    [Response Data]:`, JSON.stringify(data, null, 2));

			// Kiểm tra lỗi từ Cobalt API
			if (data.status === "error" || data.status === "rate-limit") {
				console.warn(
					`   [Skip] ${instance} báo lỗi: ${data.text || data.error}`
				);
				lastError = data.text || data.error || "Unknown error";
				continue;
			}

			// Thành công
			if (
				data.status === "tunnel" ||
				data.status === "redirect" ||
				data.url
			) {
				return data;
			}

			// Nếu có picker (nhiều lựa chọn)
			if (data.picker && data.picker.length > 0) {
				return data;
			}

			throw new Error("Response không hợp lệ từ Cobalt");
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
		// Gọi Cobalt để lấy info
		const result = await fetchFromCobalt(url, {
			videoQuality: "1080",
			downloadMode: "auto",
		});

		// Lấy ID video từ URL
		let videoId = "unknown";
		let thumbnailUrl = "https://i.ytimg.com/vi/mqdefault.jpg";

		const regExp =
			/^.*((youtu.be\/)|(v\/)|(\/u\/\w\/)|(embed\/)|(watch\?))\??v?=?([^#&?]*).*/;
		const match = url.match(regExp);
		if (match && match[7].length === 11) {
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
			error: "Không thể lấy thông tin video. Vui lòng kiểm tra lại link.",
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

		// Cấu hình dựa trên loại tải xuống
		if (type === "audio") {
			cobaltConfig = {
				audioFormat: "mp3",
				downloadMode: "audio",
			};
		} else if (type === "video_silent") {
			// Video 4K không tiếng
			cobaltConfig = {
				videoQuality: "max",
				downloadMode: "auto",
			};
		} else {
			// Video Full HD mặc định
			cobaltConfig = {
				videoQuality: "1080",
				downloadMode: "auto",
			};
		}

		const result = await fetchFromCobalt(url, cobaltConfig);

		// Xử lý các loại response từ Cobalt
		if (result.url) {
			// Link trực tiếp
			console.log(`[DOWNLOAD SUCCESS] Redirecting to: ${result.url}`);
			return res.redirect(result.url);
		} else if (result.picker && result.picker.length > 0) {
			// Nhiều lựa chọn, lấy cái đầu tiên
			console.log(
				`[DOWNLOAD SUCCESS] Using picker[0]: ${result.picker[0].url}`
			);
			return res.redirect(result.picker[0].url);
		} else {
			throw new Error("Không tìm thấy link tải xuống");
		}
	} catch (error) {
		console.error("[DOWNLOAD ERROR]:", error.message);
		res.status(500).send(`Lỗi tải xuống: ${error.message}`);
	}
});

// --- API PLAYLIST (Chưa hỗ trợ) ---
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
		version: "2.0",
	});
});

// --- Khởi động server ---
app.listen(PORT, () => {
	console.log("=".repeat(50));
	console.log(`🚀 Cobalt Proxy Backend đang chạy!`);
	console.log(`📍 Port: ${PORT}`);
	console.log(`🔗 API: http://localhost:${PORT}`);
	console.log("=".repeat(50));
});
