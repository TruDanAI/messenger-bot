require('dotenv').config();
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const Shop = require('./core/models/Shop');
const { connectDB } = require('./core/db');

async function migrate() {
    await connectDB();
    
    const SHOPS_DIR = path.join(__dirname, 'shops');
    const shops = fs.readdirSync(SHOPS_DIR).filter(f => fs.statSync(path.join(SHOPS_DIR, f)).isDirectory());

    for (const shopId of shops) {
        const configPath = path.join(SHOPS_DIR, shopId, 'config.js');
        if (!fs.existsSync(configPath)) continue;

        console.log(`Migrating ${shopId}...`);
        const config = require(configPath);
        
        let shop = await Shop.findById(shopId);
        if (!shop) {
            console.log(`Creating missing shop record for ${shopId}`);
            // Note: We need some basic credentials to create a valid shop if it doesn't exist
            // but for migration we'll just try to update existing ones.
            continue;
        }

        // Map config.js fields to Shop model fields
        shop.minAge = config.minAge || 0;
        if (config.policies) {
            shop.policies = {
                freeShipping: config.policies.freeShipping ?? true,
                privacy: config.policies.privacy || "",
                payment: config.policies.payment || "",
                preorderDays: config.policies.preorderDays || "",
                orderInfoFields: config.policies.orderInfoFields || "tên người nhận + SĐT + địa chỉ giao hàng"
            };
        }
        
        shop.recommendations = config.recommendations || {};
        
        // Convert keywordProducts regex to strings
        if (config.keywordProducts) {
            const kw = {};
            for (const [k, v] of Object.entries(config.keywordProducts)) {
                kw[k] = v instanceof RegExp ? v.source : String(v);
            }
            shop.keywordProducts = kw;
        }

        shop.templates = config.templates || {};
        
        // Handle intents
        const customPath = path.join(SHOPS_DIR, shopId, 'custom-intents.js');
        let prepend = [];
        let append = [];
        if (fs.existsSync(customPath)) {
            const custom = require(customPath);
            prepend = custom.prepend || [];
            append = custom.append || [];
        }

        shop.intents = {
            disabled: config.intents?.disabled || [],
            prepend: [...prepend, ...(config.intents?.prepend || [])],
            append: [...(config.intents?.append || []), ...append]
        };

        if (config.fallbackReply) {
            shop.configOverrides = { ...shop.configOverrides, fallbackReply: config.fallbackReply };
        }

        await shop.save();
        console.log(`✅ Migrated ${shopId} successfully.`);
    }

    console.log('Migration complete.');
    process.exit(0);
}

migrate().catch(err => {
    console.error('Migration failed:', err);
    process.exit(1);
});
