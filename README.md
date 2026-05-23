# Wardix Multi-Ping - Realtime IP Monitor

Wardix Multi-Ping adalah aplikasi pemantauan IP multi-ping real-time yang modern, indah, dan berkinerja tinggi. Aplikasi ini dibangun menggunakan Node.js dan Express untuk backend (yang mengeksekusi perintah `ping` bawaan sistem secara asinkron), serta antarmuka web Glassmorphism Dark Mode yang menakjubkan dengan Vanilla CSS dan Javascript murni di frontend.

![Pratinjau Wardix Multi-Ping](https://images.unsplash.com/photo-1551288049-bebda4e38f71?auto=format&fit=crop&w=800&q=85) <!-- Ilustrasi representatif -->

## Fitur Utama

- **Dashboard Real-Time**: Pemantauan latensi, persentase paket loss, dan status (Online/Offline) secara instan menggunakan WebSocket.
- **Glassmorphism Dark UI**: Desain antarmuka modern yang futuristik, bersih, sangat responsif, dan memanjakan mata.
- **Sparkline Latensi Kustom**: Grafik micro-chart SVG berkinerja tinggi yang menampilkan riwayat latensi 20 ping terakhir tanpa membebani browser dengan pustaka eksternal.
- **Sistem Alarm Audio Suara (Web Audio Synth)**: Menghasilkan bunyi alarm naik/turun yang disintesis secara dinamis saat status server berubah (tanpa perlu mengunduh file suara tambahan).
- **Notifikasi Desktop Browser**: Mendukung integrasi Web Notifications API standar untuk peringatan instan saat Anda sedang membuka tab lain.
- **Manajemen Target Fleksibel**: Tambah, edit, hapus, pause, resume, atau jalankan manual ping instan untuk setiap target langsung dari dashboard.
- **Filter Grup & Kategori**: Kelompokkan IP target (misalnya: *Public DNS*, *Local Network*, *Production Servers*) untuk kemudahan penyaringan.
- **Ekspor/Impor Konfigurasi**: Simpan list target monitoring Anda dalam format file JSON standar dan impor kembali dengan satu klik.

## Cara Menjalankan

### Prasyarat
Pastikan Anda sudah menginstal **Node.js** (versi 18 ke atas disarankan) di komputer Anda.

### Langkah-langkah
1. **Masuk ke folder project**:
   ```bash
   cd /Users/tomi/wardix/multi-ping
   ```

2. **Instal dependensi**:
   ```bash
   npm install
   ```

3. **Jalankan server**:
   - Untuk mode produksi/biasa:
     ```bash
     npm start
     ```
   - Untuk mode pengembangan (auto-reload):
     ```bash
     npm run dev
     ```

4. **Buka Browser Anda**:
   Akses dashboard di alamat:
   [http://localhost:3000](http://localhost:3000)

## Detail Teknis

- **Backend**: Node.js + Express (Webserver & REST API) + `ws` (WebSocket Server).
- **Proses Ping**: Menggunakan modul bawaan `child_process.spawn` untuk memicu binari `/sbin/ping` bawaan macOS. Sangat hemat sumber daya dan 100% andal tanpa perlu modul biner C++ eksternal yang rumit untuk dicompile.
- **Frontend**: HTML5 murni, Vanilla CSS (Custom properties, CSS Grid, Flexbox, backdrop-filters, custom keyframes), dan JavaScript ES6 standar.
- **Penyimpanan**: Disimpan di file lokal `data/hosts.json` sehingga daftar IP monitor Anda tetap aman saat server dimatikan.
