import { createApplication } from './app.js';
const app = createApplication({ databasePath: process.env.DATABASE_PATH });
try {
  const techAdmin = /^(1|true|yes)$/i.test(process.env.ADMIN_TECH || '');
  await app.createAdmin({
    name: process.env.ADMIN_NAME || 'YYC Broker',
    email: process.env.ADMIN_EMAIL,
    password: process.env.ADMIN_PASSWORD,
    phone: process.env.ADMIN_PHONE || 'Contact YYC',
    techAdmin,
  });
  console.log(
    techAdmin
      ? 'Broker account created with technical administrator access.'
      : 'Broker account created.',
  );
} finally {
  app.close();
}
