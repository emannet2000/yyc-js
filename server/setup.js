import { createApplication } from './app.js';
const app = createApplication({ databasePath: process.env.DATABASE_PATH });
try {
  const token = app.createSetupToken();
  console.log('Open the workspace login page and choose Set up broker account.');
  console.log('One-time setup token (expires in 30 minutes): ' + token);
} finally {
  app.close();
}
