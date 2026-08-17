function formatRupiahJs(number) {
    return new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(number);
}

function calculateInvoice() {
    const tbody = document.getElementById('itemsBody');
    const rows = tbody.querySelectorAll('tr');
    
    let subtotal = 0;
    let tax = 0;

    rows.forEach(row => {
        const qty = parseInt(row.querySelector('.qty').value) || 0;
        const price = parseInt(row.querySelector('.price').value) || 0;
        const discountRate = parseFloat(row.querySelector('.disc').value) || 0;
        const taxRate = parseFloat(row.querySelector('.tax').value) || 0;

        const lineSubtotal = qty * price;
        const lineDiscount = Math.round((lineSubtotal * discountRate) / 100);
        const lineNet = lineSubtotal - lineDiscount;
        const lineTax = Math.round((lineNet * taxRate) / 100);
        const lineTotal = lineNet + lineTax;

        row.querySelector('.line-total').innerText = formatRupiahJs(lineTotal);
        
        subtotal += lineNet;
        tax += lineTax;
    });

    const grandTotal = subtotal + tax;

    document.getElementById('ui-subtotal').innerText = formatRupiahJs(subtotal);
    document.getElementById('ui-tax').innerText = formatRupiahJs(tax);
    document.getElementById('ui-total').innerText = formatRupiahJs(grandTotal);
}

function addItem() {
    const tbody = document.getElementById('itemsBody');
    const index = tbody.children.length;
    
    // Ditambahkan min-width inline agar kolom input tidak akan pernah menimpa satu sama lain
    // Serta menempatkan default disc 0 di kolom yang TEPAT
    const tr = document.createElement('tr');
    tr.innerHTML = `
        <td style="min-width: 250px;">
            <input type="text" name="items[${index}][description]" class="form-control mb-1 text-sm" placeholder="Nama Layanan / Barang..." required>
            <input type="text" name="items[${index}][period]" class="form-control text-xs" placeholder="Period (Opsional, cth: Jan 2026)">
        </td>
        <td style="min-width: 80px;">
            <input type="number" name="items[${index}][quantity]" class="form-control qty text-sm text-center" placeholder="1" value="1" min="1" oninput="calculateInvoice()">
        </td>
        <td style="min-width: 150px;">
            <input type="number" name="items[${index}][price]" class="form-control price text-sm text-right" placeholder="0" value="0" min="0" oninput="calculateInvoice()">
        </td>
        <td style="min-width: 80px;">
            <input type="number" name="items[${index}][discount]" class="form-control disc text-sm text-center" placeholder="0" value="0" min="0" oninput="calculateInvoice()">
        </td>
        <td style="min-width: 80px;">
            <input type="number" step="0.1" name="items[${index}][taxRate]" class="form-control tax text-sm text-center" placeholder="11" value="11" min="0" oninput="calculateInvoice()">
        </td>
        <td class="text-right font-medium line-total pt-3" style="min-width: 120px;">Rp 0</td>
        <td class="text-center pt-2">
            <button type="button" class="btn btn-sm btn-outline text-red-500" style="padding: 4px 8px; border-color: var(--danger);" onclick="this.closest('tr').remove(); calculateInvoice();" title="Hapus baris ini">X</button>
        </td>
    `;
    tbody.appendChild(tr);
    calculateInvoice();
}
