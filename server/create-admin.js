import { createApplication } from './app.js';
const app = createApplication({ databasePath: process.env.DATABASE_PATH });
try {
  await app.createAdmin({
    name: process.env.ADMIN_NAME || 'YYC Broker',
    email: process.env.ADMIN_EMAIL,
    password: process.env.ADMIN_PASSWORD,
    phone: process.env.ADMIN_PHONE || 'Contact YYC',
  });
  console.log('Broker account created.');
} finally {
  app.close();
}
