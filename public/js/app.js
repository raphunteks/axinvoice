// Shared Utilities for AXA XYZ Frontend
// Keep frontend code minimal as server does the heavy lifting.
document.addEventListener("DOMContentLoaded", () => {
    // Auto-hide alerts after 5 seconds
    const alerts = document.querySelectorAll('.alert');
    if (alerts.length > 0) {
        setTimeout(() => {
            alerts.forEach(a => a.style.display = 'none');
        }, 5000);
    }
});