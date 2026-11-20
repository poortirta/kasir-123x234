/*
 * Toko 123 — Cleanter Direct Print Bridge
 * Target: Android Chrome + Cleanter >= 1.1.0 + Bluetooth Classic ESC/POS printer
 * Paper: 80 mm
 *
 * Install this file after the existing inline application <script> in index.html.
 * It intentionally does NOT probe localhost on page load. The first localhost
 * request is made only after the cashier taps a print button, which is required
 * by Chrome's Local Network Access permission flow on current versions.
 */
(function () {
  'use strict';

  const BRIDGE = 'http://localhost:9100';
  const PAPER_WIDTH = 80;
  let printBusy = false;

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

  function money(value) {
    return Math.round(Number(value) || 0).toLocaleString('id-ID');
  }

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
          String(item.qty) + ' ' + String(item.unit || '') + ' x ' + money(item.price),
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
      return 'Chrome belum dapat mengakses Cleanter. Pastikan Cleanter aktif dan versi terbaru. Saat pertama kali diminta, izinkan akses “apps dan layanan lain di perangkat ini”. Jika izin pernah ditolak/ditutup, buka ikon di kiri alamat Chrome → Permissions → Apps on device, aktifkan atau Reset permissions, lalu coba lagi.';
    }
    return message;
  }

  async function sendSaleToPrinter(sale) {
    if (printBusy) return;
    if (!sale || sale.bill) throw new Error('Hanya transaksi yang sudah disimpan yang dapat dicetak dari tombol ini.');
    if (sale.void) throw new Error('Transaksi ini sudah dibatalkan dan tidak dicetak.');

    printBusy = true;
    const button = document.querySelector('#modal .row.mt button[onclick="printReceiptNow()"]');
    const previousText = button ? button.textContent : '';
    if (button) { button.disabled = true; button.textContent = 'Menghubungkan printer...'; }
    showStatus('Menghubungkan ke Cleanter dan memeriksa printer… Jika Chrome meminta izin perangkat, pilih Izinkan.', 'busy');

    try {
      // IMPORTANT: First localhost call is deliberately inside this user click.
      // Chrome 150+ may show Local Network Access permission here.
      const health = await fetchJson(BRIDGE + '/health', { method: 'GET', cache: 'no-store' }, 45000);
      if (!health.response.ok || !health.body || health.body.status !== 'ok') {
        throw new Error('Cleanter tidak siap. Buka aplikasi Cleanter di Android.');
      }
      if (!health.body.printer || !health.body.printer.connected) {
        const problem = health.body.printer && health.body.printer.problem;
        throw new Error(problem || 'Printer belum terhubung. Pilih Blueprint ECO 80 sebagai printer default di Cleanter.');
      }

      if (button) button.textContent = 'Mengirim struk...';
      const payload = {
        paperWidth: PAPER_WIDTH,
        cut: true,
        content: buildReceipt(sale)
      };
      // `reference` is documented from Cleanter v1.5.0; omit on older versions.
      const version = String(health.body.version || '0').split('.').map(Number);
      if ((version[0] || 0) > 1 || ((version[0] || 0) === 1 && (version[1] || 0) >= 5)) {
        payload.reference = String(sale.no || 'Toko 123').slice(0, 64);
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

      showStatus('Struk ' + (sale.no || '') + ' berhasil dikirim ke printer Blueprint ECO 80.', 'ok');
      if (typeof toast === 'function') toast('Struk berhasil dicetak');
      return printed.body;
    } catch (error) {
      const message = explainBridgeError(error);
      showStatus(message, 'error');
      if (typeof toast === 'function') toast(message);
      throw error;
    } finally {
      printBusy = false;
      if (button) { button.disabled = false; button.textContent = previousText || 'Cetak Struk'; }
    }
  }

  // Replace the existing modal receipt button handler. Other print functions
  // (A4 reports, stock lists, and pre-payment bill preview) remain unchanged.
  window.printReceiptNow = async function () {
    if (!window.curReceipt && typeof curReceipt === 'undefined') {
      showStatus('Tidak ada transaksi yang dipilih.', 'error');
      return;
    }
    try {
      const sale = typeof curReceipt !== 'undefined' ? curReceipt : window.curReceipt;
      await sendSaleToPrinter(sale);
    } catch (_) {
      // The detailed reason is already shown in the status panel.
    }
  };

  // Route the “Cetak Struk Terakhir” action through Cleanter as well.
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

  // Add a small, explicit setup hint in the existing print modal.
  document.addEventListener('DOMContentLoaded', function () {
    const modalBody = document.getElementById('modalBody');
    if (modalBody) statusNode();
  });
})();
