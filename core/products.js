const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const Product = require('./models/Product');

/**
 * Load sản phẩm cho Shop. 
 * Ưu tiên lấy từ MongoDB. Nếu không có, đọc từ CSV và sync vào DB.
 */
async function getProductsForShop(shopId, csvPath) {
  try {
    // 1. Kiểm tra trong DB trước
    let products = await Product.find({ shopId, isActive: true });

    // 2. Nếu DB trống, thực hiện Migration từ CSV (chỉ chạy 1 lần)
    if (products.length === 0 && fs.existsSync(csvPath)) {
      console.log(`Syncing products from CSV for shop: ${shopId}`);
      const fileContent = fs.readFileSync(csvPath, 'utf8');
      const records = parse(fileContent, { columns: true, skip_empty_lines: true });
      
      const toInsert = records.map(r => ({
        shopId,
        code: String(r.code || '').toUpperCase(),
        name: r.name || r.code, // Fallback nếu CSV thiếu cột name
        price: r.price,
        description: r.description,
        size: r.size,
        preorder: String(r.preorder).toLowerCase() === 'true',
        image: r.image || r.imageFile || r.image_file || ''
      }));

      if (toInsert.length > 0) {
        await Product.insertMany(toInsert, { ordered: false }).catch(e => {}); // Ignore duplicates
        products = await Product.find({ shopId, isActive: true });
      }
    }

    return products;
  } catch (err) {
    console.error(`❌ LoadProducts Error (${shopId}):`, err.message);
    return [];
  }
}

/**
 * Legacy support - Giữ lại interface cũ để không làm gãy các module đang dùng
 */
function loadProducts(csvPath) {
  // Vì hàm này đang được dùng đồng bộ ở nhiều nơi, tao sẽ giữ logic cũ 
  // nhưng khuyến khích dùng async getProductsForShop cho các module mới.
  if (!fs.existsSync(csvPath)) return [];
  const fileContent = fs.readFileSync(csvPath, 'utf8');
  return parse(fileContent, { columns: true, skip_empty_lines: true });
}

module.exports = { loadProducts, getProductsForShop };
