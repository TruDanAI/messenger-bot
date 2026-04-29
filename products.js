const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');

const PRODUCTS_FILE = path.join(__dirname, 'products.csv');

function cleanCell(value) {
  const trimmed = String(value || '').trim();
  return trimmed || null;
}

function loadProducts() {
  // CSV được đọc một lần khi server khởi động, sau đó giữ trong RAM để bot trả lời nhanh.
  // Khi sửa products.csv trên production, cần restart service để dữ liệu mới được load lại.
  const csv = fs.readFileSync(PRODUCTS_FILE, 'utf8');
  const rows = parse(csv, {
    columns: true,
    skip_empty_lines: true,
    trim: true
  });

  const products = rows.map(row => ({
    code: cleanCell(row.code),
    price: cleanCell(row.price),
    description: cleanCell(row.description),
    size: cleanCell(row.size),
    weight: cleanCell(row.weight),
    gift: cleanCell(row.gift),
    preorder: String(row.preorder || '').trim().toLowerCase() === 'true',
    imageFile: cleanCell(row.imageFile)
  })).filter(product => product.code && product.price);

  if (!products.length) {
    throw new Error(`Không load được sản phẩm từ ${PRODUCTS_FILE}`);
  }

  return products;
}

module.exports = loadProducts();
