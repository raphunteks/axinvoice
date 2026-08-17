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
    
    const tr = document.createElement('tr');
    tr.innerHTML = `
        <td>
            <input type="text" name="items[${index}][description]" class="form-control mb-1 text-sm" placeholder="Item desc" required>
            <input type="text" name="items[${index}][period]" class="form-control text-xs" placeholder="Period (optional)">
        </td>
        <td class="w-16"><input type="number" name="items[${index}][quantity]" class="form-control qty text-sm" value="1" min="1" oninput="calculateInvoice()"></td>
        <td class="w-32"><input type="number" name="items[${index}][price]" class="form-control price text-sm" value="0" min="0" oninput="calculateInvoice()"></td>
        <td class="w-20"><input type="number" name="items[${index}][discount]" class="form-control disc text-sm" value="0" min="0" oninput="calculateInvoice()"></td>
        <td class="w-20"><input type="number" step="0.1" name="items[${index}][taxRate]" class="form-control tax text-sm" value="11" min="0" oninput="calculateInvoice()"></td>
        <td class="w-32 text-right font-medium line-total pt-3">Rp 0</td>
        <td class="w-10 text-center pt-3"><button type="button" class="text-red-500 font-bold" onclick="this.closest('tr').remove(); calculateInvoice();">X</button></td>
    `;
    tbody.appendChild(tr);
    calculateInvoice();
}