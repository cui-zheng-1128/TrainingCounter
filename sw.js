/* 训练倒计时 Service Worker：预缓存应用外壳，同源 GET 请求缓存优先 */
const CACHE_NAME = 'training-counter-v15';

// 预缓存文件清单
const PRECACHE_URLS = [
	'./',
	'index.html',
	'styles.css',
	'manifest.webmanifest',
	'js/app.js',
	'js/timer-engine.js',
	'js/announcer.js',
	'js/wake-lock.js',
	'js/storage.js',
	'js/vendor/sortable.min.js',
	'assets/nosleep.mp4',
	'assets/nosleep.webm',
	'assets/icons/icon-192.png',
	'assets/icons/icon-512.png',
	'assets/icons/apple-touch-icon.png',
	'assets/audio/rest.wav',
	'assets/audio/done.wav',
	'assets/audio/half.wav',
	// 数字报数音频 0.wav ~ 10.wav
	...Array.from({ length: 11 }, (_, i) => `assets/audio/${i}.wav`),
];

self.addEventListener('install', (event) => {
	event.waitUntil(
		caches
			.open(CACHE_NAME)
			.then((cache) =>
				// 单个文件失败不影响整体安装
				Promise.all(PRECACHE_URLS.map((url) => cache.add(url).catch(() => null)))
			)
			.then(() => self.skipWaiting())
	);
});

self.addEventListener('activate', (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
			.then(() => self.clients.claim())
	);
});

self.addEventListener('fetch', (event) => {
	const request = event.request;
	// 仅处理同源 GET 请求
	if (request.method !== 'GET') return;
	const url = new URL(request.url);
	if (url.origin !== self.location.origin) return;
	event.respondWith(
		caches.open(CACHE_NAME).then((cache) =>
			cache.match(request).then((cached) => {
				if (cached) return cached; // 缓存优先
				return fetch(request)
					.then((response) => {
						// 网络成功则写入缓存
						if (response && response.ok) cache.put(request, response.clone());
						return response;
					})
					.catch(() =>
						// 网络失败：导航请求回退到缓存首页
						request.mode === 'navigate' ? caches.match('./') : Response.error()
					);
			})
		)
	);
});
