const mongoose = require('mongoose');
const Lead = require('../core/models/Lead');
const Shop = require('../core/models/Shop');
require('dotenv').config();

const MONGO_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/messenger-bot';

async function seed() {
  await mongoose.connect(MONGO_URI);
  console.log('Connected to MongoDB for seeding...');

  // 1. Clear cũ để đảm bảo số liệu chính xác
  await Lead.deleteMany({});
  await Shop.deleteMany({ _id: { $in: ['shop-a', 'shop-b', 'shop-empty'] } });

  // 2. Tạo Shop
  await Shop.create([
    { _id: 'shop-a', name: 'Shop A (Test)', isActive: true, credentials: { fbPageToken: 'token-a' } },
    { _id: 'shop-b', name: 'Shop B (Test)', isActive: true, credentials: { fbPageToken: 'token-b' } },
    { _id: 'shop-empty', name: 'Shop Empty', isActive: true, credentials: { fbPageToken: 'token-empty' } }
  ]);

  const leads = [];
  const now = new Date();

  // 3. Shop A: 10 leads (6 AI, 4 Human)
  // Intents: price (5), size (3), complaint (2)
  for (let i = 0; i < 10; i++) {
    leads.push({
      shopId: 'shop-a',
      senderId: `user-a-${i}`,
      name: `User A ${i}`,
      at: now,
      handledBy: i < 6 ? 'ai' : 'human',
      intent: i < 5 ? 'price' : (i < 8 ? 'size' : 'complaint'),
      status: 'new'
    });
  }

  // 4. Shop B: 5 leads (1 AI, 4 Human)
  // Intent: delivery (5)
  for (let i = 0; i < 5; i++) {
    leads.push({
      shopId: 'shop-b',
      senderId: `user-b-${i}`,
      name: `User B ${i}`,
      at: now,
      handledBy: i < 1 ? 'ai' : 'human',
      intent: 'delivery',
      status: 'new'
    });
  }

  await Lead.insertMany(leads);
  console.log('Seed completed successfully!');
  console.log('Shop A: 10 leads (6 AI / 4 Human)');
  console.log('Shop B: 5 leads (1 AI / 4 Human)');
  console.log('Total Global: 15 leads (7 AI / 8 Human)');
  
  await mongoose.disconnect();
}

seed();
