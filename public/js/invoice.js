function formatRupiahJs(number) {
    return new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(number);
}

function calculateInvoice() {
    const tbody = document.getElementById('itemsBody');
    const rows = tbody.querySelectorAll('tr');
    
    let subtotal = 0;

    rows.forEach(row => {
        const qty = parseInt(row.querySelector('.qty').value) || 0;
        const price = parseInt(row.querySelector('.price').value) || 0;

        const lineTotal = qty * price;
        row.querySelector('.line-total').innerText = formatRupiahJs(lineTotal);
        
        subtotal += lineTotal;
    });

    const globalDiscRate = parseFloat(document.getElementById('globalDiscountRate').value) || 0;
    const globalTaxRate = parseFloat(document.getElementById('globalTaxRate').value) || 0;

    const discountAmount = Math.round((subtotal * globalDiscRate) / 100);
    const taxableBase = subtotal - discountAmount;
    const taxAmount = Math.round((taxableBase * globalTaxRate) / 100);
    const grandTotal = taxableBase + taxAmount;

    document.getElementById('ui-subtotal').innerText = formatRupiahJs(subtotal);
    document.getElementById('ui-discount').innerText = "- " + formatRupiahJs(discountAmount);
    document.getElementById('ui-tax').innerText = formatRupiahJs(taxAmount);
    document.getElementById('ui-total').innerText = formatRupiahJs(grandTotal);
}

function addItem() {
    const tbody = document.getElementById('itemsBody');
    const index = tbody.children.length;
    
    // Perbaikan Super Big Upgrade: 
    // 1. Tambah div flex-col agar Description & Period tersusun atas-bawah.
    // 2. Tambah white-space: normal agar tidak memaksa memanjang ke kanan.
    // 3. Menghapus Disc & Tax (kini menjadi Global).
    const tr = document.createElement('tr');
    tr.innerHTML = `
        <td style="min-width: 270px; white-space: normal; vertical-align: top;">
            <div style="display: flex; flex-direction: column; gap: 8px;">
                <input type="text" name="items[${index}][description]" class="form-control text-sm" placeholder="Nama Layanan / Barang..." required>
                <input type="text" name="items[${index}][period]" class="form-control text-xs" placeholder="Period (Opsional, cth: Jan 2026)">
            </div>
        </td>
        <td style="min-width: 90px; vertical-align: top;">
            <input type="number" name="items[${index}][quantity]" class="form-control qty text-sm text-center" placeholder="1" value="1" min="1" oninput="calculateInvoice()">
        </td>
        <td style="min-width: 150px; vertical-align: top;">
            <input type="number" name="items[${index}][price]" class="form-control price text-sm text-right" placeholder="0" value="0" min="0" oninput="calculateInvoice()">
        </td>
        <td class="text-right font-medium line-total pt-3" style="min-width: 130px; vertical-align: top;">Rp 0</td>
        <td class="text-center pt-2" style="vertical-align: top;">
            <button type="button" class="btn btn-sm btn-outline text-red-500" style="padding: 4px 8px; border-color: var(--danger);" onclick="this.closest('tr').remove(); calculateInvoice();" title="Hapus baris ini">X</button>
        </td>
    `;
    tbody.appendChild(tr);
    calculateInvoice();
}
