/*
 * Toko 123 — Cleanter Direct Print Bridge + Antrean Cetak Multi-Perangkat
 * Paper: 80 mm | Printer: Bluetooth Classic ESC/POS via aplikasi Cleanter (Android)
 *
 * MODE (Pengaturan → "Printer & Cetak Struk", disimpan per perangkat):
 *   local  : cetak langsung ke Cleanter di perangkat ini (perilaku lama, default)
 *   host   : "Pusat Cetak" — seperti local, DAN menerima kerja cetak dari perangkat lain
 *   remote : tidak punya printer — kirim struk ke Pusat Cetak lewat Supabase
 *
 * Antrean memakai tabel `store` Supabase yang sudah ada (kind = 'printjob' dan
 * 'printhost'). TIDAK perlu mengubah SQL.
 *
 * Pasang file ini setelah <script> inline utama di index.html (sudah begitu).
 */
(function () {
  'use strict';

  const BRIDGE = 'http://localhost:9100';
  const PAPER_WIDTH = 80;
  const MODE_LS = 't123_printmode';
  const POLL_MS = 4000;            // host cek antrean tiap 4 dtk
  const BEAT_MS = 10000;           // host kirim "saya aktif" tiap 10 dtk
  const HOST_FRESH_MS = 90000;     // pengirim menganggap host aktif bila beat < 90 dtk
  const JOB_EXPIRE_MS = 10 * 60000;// kerja cetak > 10 menit dibuang (hindari cetak ulang tak sengaja)
  const WAIT_MS = 40000;           // pengirim menunggu hasil maks 40 dtk
  const MAX_ATTEMPTS = 3;
  let printBusy = false;

  /* ------------------------------------------------------------------ */
  /* Util UI                                                             */
  /* ------------------------------------------------------------------ */
  function getMode() {
    try { const m = localStorage.getItem(MODE_LS); if (m === 'host' || m === 'remote') return m; } catch (_) {}
    return 'local';
  }
  function setMode(m) { try { localStorage.setItem(MODE_LS, m); } catch (_) {} }

  // Ukuran huruf struk (diatur di perangkat yang tersambung printer):
  //   normal | medium-names | medium-all | large-names | large-all
  //   "names" = nama barang & teks saja; "all" = semua baris (baris angka dipecah jadi 2 baris teks)
  const FONT_LS = 't123_printfont';
  const FONT_OK = ['medium-names', 'medium-all', 'large-names', 'large-all'];
  function getFont() {
    try {
      let f = localStorage.getItem(FONT_LS);
      if (f === 'names') f = 'large-names';   // nilai lama
      if (f === 'all') f = 'large-all';       // nilai lama
      if (FONT_OK.indexOf(f) >= 0) return f;
    } catch (_) {}
    return 'normal';
  }
  function setFont(f) { try { localStorage.setItem(FONT_LS, f); } catch (_) {} }
  function applyFont(content) {
    const f = getFont();
    if (f === 'normal') return content;
    const size = f.indexOf('medium') === 0 ? 'medium' : 'large';
    const all = /-all$/.test(f);
    const out = [];
    content.forEach(function (el) {
      if (!el) return;
      if (el.type === 'text') {
        out.push(el.size ? el : Object.assign({}, el, { size: size }));
      } else if (all && el.type === 'row') {
        // 'row' tidak mendukung ukuran huruf -> pecah jadi teks kiri + teks kanan (rata kanan)
        const bold = el.bold ? { bold: true } : {};
        if (el.left) out.push(Object.assign({ type: 'text', text: String(el.left), size: size }, bold));
        if (el.right) out.push(Object.assign({ type: 'text', text: String(el.right), align: 'right', size: size }, bold));
      } else {
        out.push(el);
      }
    });
    return out;
  }

  function statusNode() {
    let el = document.getElementById('cleanterPrintStatus');
    if (!el) {
      el = document.createElement('div');
      el.id = 'cleanterPrintStatus';
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'polite');
      el.style.cssText = 'margin-top:10px;padding:9px 12px;border:1px solid #34343d;border-radius:10px;font-size:13px;color:#cbd5e1;background:#17171b;display:none;';
      const modalBody = document.getElementById('modalBody');
      if (modalBody && modalBody.parentElement) {
        const actionRow = modalBody.parentElement.querySelector('.row.mt');
        if (actionRow) actionRow.insertAdjacentElement('afterend', el);
        else modalBody.insertAdjacentElement('afterend', el);
      } else {
        document.body.appendChild(el);
      }
    }
    return el;
  }

  function showStatus(message, kind) {
    const el = statusNode();
    el.style.display = 'block';
    el.textContent = message;
    el.style.borderColor = kind === 'ok' ? '#10b981' : kind === 'error' ? '#f59e0b' : '#475569';
    el.style.color = kind === 'ok' ? '#6ee7b7' : kind === 'error' ? '#fbbf24' : '#cbd5e1';
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  function money(value) { return Math.round(Number(value) || 0).toLocaleString('id-ID'); }

  /* ------------------------------------------------------------------ */
  /* Susun isi struk (tidak berubah)                                     */
  /* ------------------------------------------------------------------ */
  function addText(content, text, options) {
    const value = String(text == null ? '' : text).trim();
    if (!value) return;
    content.push(Object.assign({ type: 'text', text: value }, options || {}));
  }

  function addRow(content, left, right, bold) {
    content.push({
      type: 'row',
      left: String(left == null ? '' : left),
      right: String(right == null ? '' : right),
      ...(bold ? { bold: true } : {})
    });
  }

  function buildReceipt(sale) {
    if (!sale || !Array.isArray(sale.items) || !sale.items.length) {
      throw new Error('Data transaksi/daftar barang tidak ditemukan.');
    }

    const content = [];
    addText(content, settings && settings.name ? settings.name : 'TOKO', {
      align: 'center', bold: true, size: 'large'
    });
    content.push({ type: 'divider' });

    addRow(content, 'No. Struk', sale.no || '-');
    addRow(content, 'Tanggal', typeof fmtTime === 'function' ? fmtTime(sale.time) : new Date(sale.time).toLocaleString('id-ID'));
    if (sale.customer) addRow(content, 'Pelanggan', sale.customer);
    if (sale.staff) addRow(content, 'Kasir', sale.staff);
    if (sale.rev) addRow(content, 'Revisi', 'Ke-' + sale.rev);
    if (sale.void) addText(content, '*** TRANSAKSI DIBATALKAN ***', { align: 'center', bold: true });
    content.push({ type: 'divider' });

    const isTobacco = typeof isRokok === 'function' ? isRokok : function () { return false; };
    const tobacco = sale.items.filter(isTobacco);
    const others = sale.items.filter(item => !isTobacco(item));
    const both = tobacco.length > 0 && others.length > 0;

    function addItems(title, items, order) {
      if (!items.length) return;
      if (title) addText(content, title, { align: 'center', bold: true });
      items.forEach(item => {
        addText(content, item.name || 'Barang');
        addRow(
          content,
          String(item.qty) + ' ' + String(typeof normUnit === 'function' ? normUnit(item.unit) : (item.unit || '')) + ' x ' + money(item.price),
          money((Number(item.qty) || 0) * (Number(item.price) || 0))
        );
      });
      if (typeof unitSummary === 'function') {
        addRow(content, both ? 'Jumlah' : 'Jumlah item', unitSummary(items, order));
      }
      if (title) {
        const subtotal = items.reduce((sum, item) => sum + (Number(item.qty) || 0) * (Number(item.price) || 0), 0);
        addRow(content, 'Subtotal ' + title.toLowerCase(), money(subtotal));
      }
    }

    if (tobacco.length) addItems(both ? 'ROKOK' : '', tobacco, typeof ROK_ORDER !== 'undefined' ? ROK_ORDER : null);
    if (others.length) addItems(both ? 'BARANG LAIN' : '', others, null);

    content.push({ type: 'divider' });
    addRow(content, 'Subtotal', money(sale.subtotal));
    if (Number(sale.discount) > 0) addRow(content, 'Diskon', '-' + money(sale.discount));
    addRow(content, 'TOTAL', money(sale.total), true);

    if (sale.bill) {
      addText(content, 'TAGIHAN - BELUM DIBAYAR', { align: 'center', bold: true });
    } else {
      addRow(content, 'Bayar' + (sale.method ? ' (' + sale.method + ')' : ''), money(sale.paid));
      (sale.pays || []).forEach(payment => {
        addText(content, 'Bayar susulan ' + (typeof fmtTime === 'function' ? fmtTime(payment.t) : ''));
        addRow(content, 'Jumlah', money(payment.amt));
      });
      if (Number(sale.change) < 0) {
        addRow(content, 'KURANG BAYAR', '-' + money(-sale.change), true);
        addText(content, 'BELUM LUNAS (UTANG)', { align: 'center', bold: true });
      } else {
        addRow(content, 'Kembalian', money(sale.change));
      }
      content.push({ type: 'divider' });
      addText(content, settings && settings.foot ? settings.foot : 'Terima kasih atas kunjungan Anda', { align: 'center' });
    }

    content.push({ type: 'feed', lines: 3 });
    return content;
  }

  function buildTestReceipt() {
    const content = [];
    addText(content, settings && settings.name ? settings.name : 'TOKO', { align: 'center', bold: true, size: 'large' });
    content.push({ type: 'divider' });
    addText(content, 'TES CETAK', { align: 'center', bold: true });
    addRow(content, 'Waktu', new Date().toLocaleString('id-ID'));
    addText(content, 'Printer berfungsi dengan baik.', { align: 'center' });
    content.push({ type: 'feed', lines: 3 });
    return content;
  }

  /* ------------------------------------------------------------------ */
  /* Cleanter (localhost) — hanya di perangkat yang terhubung ke printer */
  /* ------------------------------------------------------------------ */
  async function fetchJson(url, options, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, Object.assign({}, options || {}, { signal: controller.signal }));
      let body = {};
      try { body = await response.json(); } catch (_) {}
      return { response, body };
    } finally {
      clearTimeout(timer);
    }
  }

  function explainBridgeError(error) {
    const message = String(error && error.message || error || 'Gagal terhubung ke Cleanter.');
    if (/AbortError|aborted/i.test(message)) {
      return 'Permintaan ke Cleanter terlalu lama. Pastikan aplikasi Cleanter terbuka dan printer menyala, lalu coba lagi.';
    }
    if (/Failed to fetch|NetworkError|Load failed/i.test(message)) {
      return 'Chrome belum dapat mengakses Cleanter. Pastikan Cleanter aktif dan versi terbaru. Saat pertama kali diminta, izinkan akses “apps dan layanan lain di perangkat ini”. Jika izin pernah ditolak/ditutup, buka ikon di kiri alamat Chrome → Permissions → Apps on device, aktifkan atau Reset permissions, lalu coba lagi. (Perangkat ini tidak punya printer? Ubah mode ke “Kirim ke perangkat printer” di Pengaturan.)';
    }
    return message;
  }

  // Pesan error sesuai mode: di mode "remote" kegagalan jaringan berarti Supabase, bukan Cleanter.
  function explainPrintError(error, mode) {
    const message = String(error && error.message || error || '');
    if (mode === 'remote') {
      if (/Failed to fetch|NetworkError|Load failed|AbortError|aborted/i.test(message)) {
        return 'Tidak dapat terhubung ke Supabase. Periksa koneksi internet perangkat ini, lalu coba lagi.';
      }
      return message || 'Gagal mengirim ke perangkat printer.';
    }
    return explainBridgeError(error);
  }

  async function bridgeHealth(timeoutMs) {
    const health = await fetchJson(BRIDGE + '/health', { method: 'GET', cache: 'no-store' }, timeoutMs || 45000);
    if (!health.response.ok || !health.body || health.body.status !== 'ok') {
      throw new Error('Cleanter tidak siap. Buka aplikasi Cleanter di Android.');
    }
    if (!health.body.printer || !health.body.printer.connected) {
      const problem = health.body.printer && health.body.printer.problem;
      throw new Error(problem || 'Printer belum terhubung. Pilih Blueprint ECO 80 sebagai printer default di Cleanter.');
    }
    return health.body;
  }

  // Kirim `content` ke printer lewat Cleanter. onStep(msg) opsional untuk update teks.
  async function cleanterPrint(content, reference, onStep) {
    const health = await bridgeHealth();
    if (onStep) onStep('Mengirim struk...');
    const payload = { paperWidth: PAPER_WIDTH, cut: true, content: applyFont(content) };
    const version = String(health.version || '0').split('.').map(Number);
    if ((version[0] || 0) > 1 || ((version[0] || 0) === 1 && (version[1] || 0) >= 5)) {
      payload.reference = String(reference || 'Toko 123').slice(0, 64);
    }
    const printed = await fetchJson(BRIDGE + '/print', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }, 45000);
    if (!printed.response.ok) {
      const detail = printed.body.fix || printed.body.detail || printed.body.error || ('HTTP ' + printed.response.status);
      throw new Error(detail);
    }
    if (printed.body.status !== 'printed') {
      throw new Error(printed.body.detail || 'Cleanter belum mengonfirmasi hasil cetak.');
    }
    return printed.body;
  }

  /* ------------------------------------------------------------------ */
  /* Supabase: antrean cetak                                             */
  /* ------------------------------------------------------------------ */
  function qOn() { return typeof syncOn === 'function' && syncOn(); }

  async function sb(method, qs, body, prefer) {
    const h = { apikey: sync.key, 'Content-Type': 'application/json' };
    if (sync.key.startsWith('eyJ')) h.Authorization = 'Bearer ' + sync.key;
    if (prefer) h.Prefer = prefer;
    const r = await fetch(sync.url + '/rest/v1/store' + qs, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
    if (!r.ok) {
      let t = ''; try { t = await r.text(); } catch (_) {}
      throw new Error('Supabase ' + r.status + ' ' + t.slice(0, 160));
    }
    const text = await r.text();
    return text ? JSON.parse(text) : null;
  }

  function newJobId() { return 'pj-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7); }

  async function enqueueJob(content, reference, saleNo) {
    const id = newJobId();
    let by = '';
    try { by = localStorage.getItem('t123_staff') || ''; } catch (_) {}
    await sb('POST', '?on_conflict=kind,id', [{
      kind: 'printjob', id: id, deleted: false, updated: Date.now(),
      data: { status: 'pending', created: Date.now(), by: by, no: saleNo || '', reference: reference || '', content: content, attempts: 0 }
    }], 'resolution=merge-duplicates,return=minimal');
    return id;
  }

  async function getHostBeat() {
    const rows = await sb('GET', '?select=data&kind=eq.printhost&id=eq.main');
    return rows && rows[0] && rows[0].data || null;
  }

  // Pengirim: tunggu hasil. Mengembalikan {ok, msg}
  async function waitJob(id, onStep) {
    const t0 = Date.now();
    while (Date.now() - t0 < WAIT_MS) {
      await sleep(2000);
      const rows = await sb('GET', '?select=data,deleted&kind=eq.printjob&id=eq.' + encodeURIComponent(id));
      const row = rows && rows[0];
      if (!row) return { ok: false, msg: 'Kerja cetak hilang dari antrean.' };
      const st = row.data && row.data.status;
      if (st === 'printed') return { ok: true };
      if (st === 'error' || st === 'expired') return { ok: false, msg: (row.data && row.data.error) || 'Perangkat printer gagal mencetak.' };
      if (onStep) onStep(row.deleted ? 'Sedang dicetak…' : 'Menunggu perangkat printer…');
    }
    // timeout: batalkan bila belum diambil, supaya tidak tercetak ganda saat dicoba lagi
    try { await sb('DELETE', '?kind=eq.printjob&id=eq.' + encodeURIComponent(id) + '&deleted=eq.false', null, 'return=minimal'); } catch (_) {}
    return { ok: false, msg: 'Perangkat printer tidak merespons. Pastikan Pusat Cetak aktif (halaman terbuka, Cleanter menyala), lalu coba lagi.' };
  }

  async function sendRemote(content, reference, saleNo, onStep) {
    if (!qOn()) throw new Error('Sinkronisasi Supabase belum aktif di perangkat ini. Aktifkan dulu di Pengaturan → Sinkronisasi Antar Perangkat.');
    if (onStep) onStep('Memeriksa perangkat printer…');
    const beat = await getHostBeat();
    if (!beat || !beat.seen || Date.now() - beat.seen > HOST_FRESH_MS) {
      throw new Error('Belum ada perangkat printer yang aktif. Di perangkat yang tersambung printer: buka aplikasi ini → Pengaturan → pilih “Pusat Cetak” → Mulai.');
    }
    if (beat.printerOk === false) {
      throw new Error('Perangkat printer aktif tetapi printer bermasalah: ' + (beat.problem || 'tidak terhubung') + '.');
    }
    if (onStep) onStep('Mengirim ke perangkat printer…');
    const id = await enqueueJob(content, reference, saleNo);
    const res = await waitJob(id, onStep);
    if (!res.ok) throw new Error(res.msg);
  }

  /* ------------------------------------------------------------------ */
  /* Tombol cetak                                                        */
  /* ------------------------------------------------------------------ */
  async function printContent(content, reference, saleNo, label) {
    if (printBusy) return;
    printBusy = true;
    const button = document.querySelector('#modal .row.mt button[onclick="printReceiptNow()"]');
    const previousText = button ? button.textContent : '';
    const mode = getMode();
    const step = function (msg) { if (button) button.textContent = msg; showStatus(msg, 'busy'); };
    if (button) button.disabled = true;
    try {
      if (mode === 'remote') {
        step('Mengirim…');
        await sendRemote(content, reference, saleNo, step);
      } else {
        step('Menghubungkan printer...');
        showStatus('Menghubungkan ke Cleanter dan memeriksa printer… Jika Chrome meminta izin perangkat, pilih Izinkan.', 'busy');
        // Panggilan localhost pertama sengaja di dalam klik pengguna (Local Network Access Chrome).
        await cleanterPrint(content, reference, step);
      }
      showStatus((label || 'Struk') + ' berhasil dicetak' + (mode === 'remote' ? ' di perangkat printer.' : '.'), 'ok');
      if (typeof toast === 'function') toast((label || 'Struk') + ' berhasil dicetak');
    } catch (error) {
      const message = explainPrintError(error, mode);
      showStatus(message, 'error');
      if (typeof toast === 'function') toast(message);
      throw error;
    } finally {
      printBusy = false;
      if (button) { button.disabled = false; button.textContent = previousText || 'Cetak Struk'; }
    }
  }

  async function sendSaleToPrinter(sale) {
    if (!sale || sale.bill) throw new Error('Hanya transaksi yang sudah disimpan yang dapat dicetak dari tombol ini.');
    if (sale.void) throw new Error('Transaksi ini sudah dibatalkan dan tidak dicetak.');
    return printContent(buildReceipt(sale), String(sale.no || 'Toko 123'), sale.no, 'Struk ' + (sale.no || ''));
  }

  window.printReceiptNow = async function () {
    if (typeof curReceipt === 'undefined' || !curReceipt) {
      showStatus('Tidak ada transaksi yang dipilih.', 'error');
      return;
    }
    try { await sendSaleToPrinter(curReceipt); } catch (_) { /* alasan sudah tampil di panel status */ }
  };

  window.printLast = async function () {
    if (!Array.isArray(sales) || !sales.length) {
      if (typeof toast === 'function') toast('Belum ada transaksi');
      return;
    }
    const sale = sales.reduce((latest, item) => item.time > latest.time ? item : latest);
    if (typeof curReceipt !== 'undefined') curReceipt = sale;
    const modal = document.getElementById('modal');
    const body = document.getElementById('modalBody');
    if (typeof receiptHTML === 'function' && body && modal) {
      body.innerHTML = receiptHTML(sale);
      modal.classList.add('on');
      await window.printReceiptNow();
    } else {
      try { await sendSaleToPrinter(sale); } catch (_) {}
    }
  };

  /* ------------------------------------------------------------------ */
  /* Pusat Cetak (host): ambil kerja cetak dari antrean lalu cetak       */
  /* ------------------------------------------------------------------ */
  const host = { running: false, timer: null, busy: false, lastBeat: 0, lastClean: 0, wake: null, printerOk: null, problem: '', msg: '' };

  function hostMsg(msg, kind) {
    host.msg = msg;
    const el = document.getElementById('printHostInfo');
    if (el) {
      el.textContent = msg;
      el.style.color = kind === 'ok' ? '#6ee7b7' : kind === 'error' ? '#fbbf24' : '';
    }
    updateBanner();
  }

  async function beat(health, problem) {
    host.lastBeat = Date.now();
    try {
      await sb('POST', '?on_conflict=kind,id', [{
        kind: 'printhost', id: 'main', deleted: false, updated: Date.now(),
        data: { seen: Date.now(), printerOk: !!health, problem: problem || '', version: health && health.version || '' }
      }], 'resolution=merge-duplicates,return=minimal');
    } catch (_) {}
  }

  async function patchJob(id, patch, extraFilter) {
    return sb('PATCH', '?kind=eq.printjob&id=eq.' + encodeURIComponent(id) + (extraFilter || ''), patch, 'return=representation');
  }

  async function processJob(job) {
    const d = job.data || {};
    // kedaluwarsa
    if (Date.now() - (d.created || 0) > JOB_EXPIRE_MS) {
      await patchJob(job.id, { deleted: true, updated: Date.now(), data: { status: 'expired', error: 'Kerja cetak kedaluwarsa.', no: d.no || '', created: d.created || 0 } }, '&deleted=eq.false');
      return;
    }
    // klaim (hanya satu perangkat yang berhasil)
    const claimed = await patchJob(job.id, { deleted: true, updated: Date.now() }, '&deleted=eq.false');
    if (!claimed || !claimed.length) return;
    hostMsg('Mencetak ' + (d.no || 'struk') + (d.by ? ' (dari ' + d.by + ')' : '') + '…', 'busy');
    try {
      await cleanterPrint(d.content || [], d.reference || d.no || 'Toko 123');
      await patchJob(job.id, { deleted: true, updated: Date.now(), data: { status: 'printed', no: d.no || '', by: d.by || '', created: d.created || 0, printedAt: Date.now() } });
      hostMsg('Terakhir mencetak ' + (d.no || 'struk') + ' pukul ' + new Date().toLocaleTimeString('id-ID') + '.', 'ok');
    } catch (err) {
      const attempts = (d.attempts || 0) + 1;
      const msg = explainBridgeError(err);
      if (attempts < MAX_ATTEMPTS) {
        // kembalikan ke antrean untuk dicoba lagi
        const nd = Object.assign({}, d, { attempts: attempts, lastError: msg });
        await patchJob(job.id, { deleted: false, updated: Date.now(), data: nd });
      } else {
        await patchJob(job.id, { deleted: true, updated: Date.now(), data: { status: 'error', error: msg, no: d.no || '', created: d.created || 0 } });
      }
      hostMsg('Gagal mencetak ' + (d.no || 'struk') + ': ' + msg, 'error');
    }
  }

  async function hostTick() {
    if (!host.running || host.busy) return;
    if (!qOn()) { hostMsg('Sinkronisasi Supabase belum aktif.', 'error'); return; }
    host.busy = true;
    try {
      // 1) heartbeat + cek printer secara berkala
      if (Date.now() - host.lastBeat >= BEAT_MS) {
        try {
          const h = await bridgeHealth(8000);
          host.printerOk = true; host.problem = '';
          await beat(h, '');
        } catch (e) {
          host.printerOk = false; host.problem = explainBridgeError(e);
          await beat(null, host.problem);
          hostMsg('Printer belum siap: ' + host.problem, 'error');
        }
      }
      // 2) bersih-bersih kerja lama (tiap 30 menit)
      if (Date.now() - host.lastClean > 30 * 60000) {
        host.lastClean = Date.now();
        try { await sb('DELETE', '?kind=eq.printjob&updated=lt.' + (Date.now() - 60 * 60000), null, 'return=minimal'); } catch (_) {}
      }
      // 3) ambil antrean
      if (host.printerOk !== false) {
        const jobs = await sb('GET', '?select=id,data&kind=eq.printjob&deleted=eq.false&order=updated.asc&limit=5');
        for (const job of (jobs || [])) await processJob(job);
        if (jobs && jobs.length === 0 && host.printerOk) hostMsg(host.msg && /^Terakhir/.test(host.msg) ? host.msg : 'Pusat Cetak aktif. Menunggu kerja cetak dari perangkat lain…', 'ok');
      }
    } catch (e) {
      hostMsg('Gagal membaca antrean: ' + (e && e.message || e), 'error');
    } finally {
      host.busy = false;
    }
  }

  async function requestWake() {
    try {
      if ('wakeLock' in navigator && !document.hidden) host.wake = await navigator.wakeLock.request('screen');
    } catch (_) {}
  }

  // Harus dipanggil dari klik pengguna (izin Local Network Access Chrome)
  async function hostStart() {
    if (!qOn()) { hostMsg('Aktifkan Sinkronisasi Supabase dulu (Pengaturan → Sinkronisasi Antar Perangkat).', 'error'); return; }
    hostMsg('Memeriksa Cleanter dan printer… Jika Chrome meminta izin perangkat, pilih Izinkan.', 'busy');
    try {
      const h = await bridgeHealth(45000);
      host.printerOk = true; host.problem = '';
      await beat(h, '');
    } catch (e) {
      host.printerOk = false; host.problem = explainBridgeError(e);
      hostMsg(host.problem, 'error');
      return;
    }
    host.running = true;
    clearInterval(host.timer);
    host.timer = setInterval(hostTick, POLL_MS);
    requestWake();
    hostMsg('Pusat Cetak aktif. Biarkan halaman ini terbuka dan layar menyala. Menunggu kerja cetak dari perangkat lain…', 'ok');
    hostTick();
  }

  function hostStop() {
    host.running = false;
    clearInterval(host.timer); host.timer = null;
    try { if (host.wake) host.wake.release(); } catch (_) {}
    host.wake = null;
    // tandai tidak aktif agar pengirim tahu
    if (qOn()) sb('POST', '?on_conflict=kind,id', [{ kind: 'printhost', id: 'main', deleted: false, updated: Date.now(), data: { seen: 0, printerOk: false, problem: 'Pusat Cetak dimatikan' } }], 'resolution=merge-duplicates,return=minimal').catch(function () {});
    hostMsg('Pusat Cetak berhenti.', '');
  }

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && host.running) { requestWake(); hostTick(); }
  });

  /* ------------------------------------------------------------------ */
  /* Banner "Mulai Pusat Cetak" (karena butuh ketukan setelah halaman    */
  /* dimuat ulang) dan kartu Pengaturan                                  */
  /* ------------------------------------------------------------------ */
  function updateBanner() {
    let b = document.getElementById('printHostBanner');
    const need = getMode() === 'host' && !host.running;
    if (!need) { if (b) b.style.display = 'none'; return; }
    if (!b) {
      b = document.createElement('button');
      b.id = 'printHostBanner';
      b.type = 'button';
      b.textContent = '🖨 Ketuk untuk mengaktifkan Pusat Cetak';
      b.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:9999;padding:10px 14px;border-radius:12px;border:1px solid #f59e0b;background:#17171b;color:#fbbf24;font-size:14px;cursor:pointer;';
      b.onclick = function () { hostStart(); };
      document.body.appendChild(b);
    }
    b.style.display = 'block';
  }

  function buildSettingsCard() {
    if (document.getElementById('printSetupCard')) return;
    const section = document.getElementById('setting');
    if (!section) return;
    const card = document.createElement('div');
    card.className = 'card mt';
    card.id = 'printSetupCard';
    card.innerHTML =
      '<h3>Printer &amp; Cetak Struk</h3>' +
      '<p class="sub">Printer Bluetooth hanya bisa tersambung ke satu HP. Jadikan HP itu <b>Pusat Cetak</b>; perangkat lain (HP/komputer) memilih <b>Kirim ke perangkat printer</b>. Struk dikirim lewat Supabase, jadi sinkronisasi harus aktif di semua perangkat. Pengaturan ini berlaku per perangkat.</p>' +
      '<div class="form"><div style="grid-column:span 2"><label>Mode perangkat ini</label>' +
      '<select id="printMode">' +
      '<option value="local">Cetak langsung (printer tersambung di perangkat ini)</option>' +
      '<option value="host">Pusat Cetak (printer di sini + terima cetakan dari perangkat lain)</option>' +
      '<option value="remote">Kirim ke perangkat printer (tanpa printer di sini)</option>' +
      '</select></div>' +
      '<div style="grid-column:span 2"><label>Ukuran huruf struk (berlaku di perangkat yang tersambung printer)</label>' +
      '<select id="printFont">' +
      '<option value="normal">Normal</option>' +
      '<option value="medium-names">Sedang: nama barang &amp; teks</option>' +
      '<option value="medium-all">Sedang: semua baris</option>' +
      '<option value="large-names">Besar: nama barang &amp; teks</option>' +
      '<option value="large-all">Besar: semua baris</option>' +
      '</select></div></div>' +
      '<div class="row mt">' +
      '<button class="btn fit" id="printHostBtn" type="button">Mulai Pusat Cetak</button>' +
      '<button class="btn sec fit" id="printTestBtn" type="button">Tes Cetak</button>' +
      '</div>' +
      '<p id="printHostInfo" class="sub mt"></p>' +
      '<p class="sub">Tips Pusat Cetak: biarkan aplikasi ini terbuka di Chrome pada HP printer dengan layar menyala dan Cleanter aktif. Setelah halaman dimuat ulang, ketuk tombol “Mulai Pusat Cetak” sekali lagi.</p>';
    const syncTitle = Array.from(section.querySelectorAll('h3')).find(h => /Sinkronisasi/i.test(h.textContent));
    const anchor = syncTitle && syncTitle.closest('.card');
    if (anchor) anchor.insertAdjacentElement('afterend', card);
    else section.appendChild(card);

    const sel = card.querySelector('#printMode');
    sel.value = getMode();
    const refresh = function () {
      const m = getMode();
      card.querySelector('#printHostBtn').style.display = m === 'host' ? '' : 'none';
      card.querySelector('#printHostBtn').textContent = host.running ? 'Hentikan Pusat Cetak' : 'Mulai Pusat Cetak';
      if (m !== 'host' && host.running) hostStop();
      updateBanner();
    };
    sel.addEventListener('change', function () { setMode(sel.value); refresh(); });
    const fsel = card.querySelector('#printFont');
    fsel.value = getFont();
    fsel.addEventListener('change', function () { setFont(fsel.value); });
    card.querySelector('#printHostBtn').addEventListener('click', async function () {
      if (host.running) hostStop(); else await hostStart();
      refresh();
    });
    card.querySelector('#printTestBtn').addEventListener('click', async function () {
      const info = document.getElementById('printHostInfo');
      const mode = getMode();
      try {
        info.textContent = 'Mengirim tes cetak…';
        if (mode === 'remote') await sendRemote(buildTestReceipt(), 'Tes cetak', 'TES', function (m) { info.textContent = m; });
        else await cleanterPrint(buildTestReceipt(), 'Tes cetak', function (m) { info.textContent = m; });
        info.textContent = 'Tes cetak berhasil.'; info.style.color = '#6ee7b7';
      } catch (e) { info.textContent = explainPrintError(e, mode); info.style.color = '#fbbf24'; }
    });
    refresh();
  }

  function init() {
    statusNode();
    buildSettingsCard();
    updateBanner();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
