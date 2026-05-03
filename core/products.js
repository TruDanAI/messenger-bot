const fs = require('fs');
const { parse } = require('csv-parse/sync');

function cleanCell(value) {
  const trimmed = String(value || '').trim();
  return trimmed || null;
}

/**
 * Đọc danh sách sản phẩm từ CSV (đường dẫn tuyệt đối hoặc tương đối).
 * Gọi khi khởi động theo từng shop trong shops/<id>/products.csv.
 */
function loadProducts(csvPath) {
  if (!csvPath || !fs.existsSync(csvPath)) {
    throw new Error(`Không tìm thấy file sản phẩm: ${csvPath}`);
  }
  const csv = fs.readFileSync(csvPath, 'utf8');
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
    throw new Error(`Không load được sản phẩm từ ${csvPath}`);
  }

  return products;
}

module.exports = {
  loadProducts
};
