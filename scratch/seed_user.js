const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const User = require('../core/models/User');
require('dotenv').config();

const MONGO_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/messenger-bot';

async function seedUser() {
  await mongoose.connect(MONGO_URI);
  console.log('Connected to MongoDB for user seeding...');

  // 1. Clear old users
  await User.deleteMany({ email: 'admin@zenbot.ai' });

  // 2. Create Admin User
  const passwordHash = await bcrypt.hash('admin123', 10);
  await User.create({
    email: 'admin@zenbot.ai',
    passwordHash: passwordHash,
    role: 'admin',
    shopIds: ['shop-a', 'shop-b'], // Admin can see these, or all if role is admin
    name: 'Super Admin',
    isActive: true
  });

  console.log('Admin user created: admin@zenbot.ai / admin123');
  
  await mongoose.disconnect();
}

seedUser();
