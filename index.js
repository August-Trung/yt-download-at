const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const app = express();

const PORT = process.env.PORT || 4000;

app.use(cors({ origin: "*", methods: ["GET", "POST"] }));
app.use(express.json());

// --- DANH SÁCH SERVER COBALT (Cân bằng tải & Dự phòng) ---
// Nếu server này chết, tự động nhảy sang server khác
const COBALT_INSTANCES = [
	"https://api.cobalt.tools",
	"https://co.wuk.sh",
	"https://cobalt.kwiatekmiki.pl",
	"https://cobalt.tools",
];

// Helper: Gọi API Cobalt với cơ chế Retry
const fetchFromCobalt = async (url, config = {}) => {
	let lastError = null;

	for (const instance of COBALT_INSTANCES) {
		try {
			console.log(`--> [Cobalt] Đang thử server: ${instance}`);

			const response = await fetch(`${instance}/api/json`, {
				method: "POST",
				headers: {
					Accept: "application/json",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					url: url,
					filenamePattern: "basic",
					...config,
				}),
			});

			// Nếu server chết hoặc trả về HTML lỗi
			if (!response.ok) throw new Error(`HTTP Error ${response.status}`);

			const data = await response.json();

			if (data.status === "error" || data.status === "rate-limit") {
				console.warn(`   [Skip] ${instance} báo lỗi: ${data.text}`);
				lastError = data.text;
				continue; // Thử server tiếp theo
			}

			return data; // Thành công
		} catch (e) {
			console.warn(`   [Skip] ${instance} không phản hồi: ${e.message}`);
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

	try {
		// Gọi Cobalt để lấy info (Mặc định lấy 720p)
		const result = await fetchFromCobalt(url);

		// Map dữ liệu từ Cobalt về định dạng của Frontend
		// Cobalt không trả về ID hay Channel name, ta phải tự xử lý sơ bộ
		let videoId = "unknown";
		let thumbnailUrl = "https://i.ytimg.com/vi/mqdefault.jpg";

		// Regex lấy ID từ URL youtube
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
			channel: "YouTube Channel", // Cobalt không cung cấp tên kênh
			views: "---", // Cobalt không cung cấp views
			description: "Video đã sẵn sàng tải xuống (Powered by Cobalt).",
			thumbnailUrl: thumbnailUrl,
			script: "",
		};

		res.json(metadata);
	} catch (error) {
		console.error("Info Error:", error.message);
		res.status(500).json({
			error: "Không thể lấy thông tin. Server quá tải hoặc link lỗi.",
		});
	}
});

// --- API DOWNLOAD ---
app.get("/api/download", async (req, res) => {
	const { url, type } = req.query;
	if (!url) return res.status(400).send("Thiếu URL");

	console.log(`--> [Download Request] ${url} [${type}]`);

	try {
		let cobaltConfig = {};

		// Cấu hình dựa trên lựa chọn người dùng
		if (type === "audio") {
			cobaltConfig = {
				isAudioOnly: true,
				aFormat: "mp3",
			};
		} else if (type === "video_silent") {
			// Frontend gọi là 'silent' (4K), nhưng Cobalt hỗ trợ 4K CÓ TIẾNG (Muxed)
			// Nên ta request max quality
			cobaltConfig = {
				vQuality: "max",
				isAudioOnly: false,
			};
		} else {
			// Video thường (Full HD)
			cobaltConfig = {
				vQuality: "1080",
				isAudioOnly: false,
			};
		}

		const result = await fetchFromCobalt(url, cobaltConfig);

		if (result.url) {
			// Cobalt trả về link trực tiếp -> Redirect người dùng tải luôn
			res.redirect(result.url);
		} else if (result.picker) {
			// Nếu có nhiều luồng, lấy cái đầu tiên
			res.redirect(result.picker[0].url);
		} else {
			throw new Error("Không tìm thấy link tải.");
		}
	} catch (error) {
		console.error("Download Error:", error.message);
		res.status(500).send(`Lỗi: ${error.message}`);
	}
});

// --- API PLAYLIST (Stub) ---
app.get("/api/playlist", (req, res) => {
	// Cobalt không hỗ trợ fetch playlist JSON.
	// Trả về lỗi để Frontend biết mà xử lý (nếu cần) hoặc bỏ qua.
	res.status(400).json({
		error: "Server hiện tại chưa hỗ trợ tải cả Playlist.",
	});
});

// Health check
app.get("/", (req, res) => {
	res.send("Cobalt Proxy Backend is Running!");
});

app.listen(PORT, () => {
	console.log(`Server Cobalt Proxy running on port ${PORT}`);
});
