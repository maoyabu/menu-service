import ejs from 'ejs';
import nodemailer from 'nodemailer';
import path from 'path';
import mongoose from 'mongoose';

export const buildTransporter = () => {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (host && user && pass) {
    return nodemailer.createTransport({ host, port, secure: port === 465, auth: { user, pass } });
  }
  return {
    sendMail: async (opts) => { console.log('[DEV] sendMail mocked:', opts.subject); }
  };
};

export const renderTemplate = async (templateName, data) => {
  const tplPath = path.resolve(process.cwd(), `utils/templates/${templateName}.ejs`);
  return `<!-- common-email-template:${templateName} -->${await ejs.renderFile(tplPath, data)}`;
};

const templateService = {
  myMenuAdded: ['plan', 'myMenuAdded'], planMenuAdded: ['plan', 'planMenuAdded'], notEating: ['plan', 'notEating'], eatingAgain: ['plan', 'eatingAgain'], dailyMenu: ['plan', 'dailyMenu'], weeklyPlanReady: ['plan', 'weeklyPlanReady'], adminMyMenuAdded: ['plan', 'adminMyMenuAdded'],
  monthlyStockReminder: ['stock', 'monthlyStockReminder'], monthlyStockReminderFollowup: ['stock', 'monthlyStockReminderFollowup'], purchaseReminder: ['stock', 'purchaseReminder'],
  equipmentInventoryReminder: ['stock', 'equipmentInventoryReminder'], taskNotification: ['board', 'taskNotification']
};

const isEnabled = async (address, html, subject = '') => {
  const match = String(html || '').match(/common-email-template:([^\s-]+)\s*-->/);
  let target = match && templateService[match[1]];
  if (match?.[1] === 'taskNotification') target = String(subject).includes('パッキング') ? ['packing', 'taskNotification'] : ['board', 'taskNotification'];
  if (!target || !mongoose.connection?.readyState || !address) return true;
  const user = await mongoose.connection.collection('users').findOne({ email: String(address).trim().toLowerCase() }, { projection: { isMail: 1, serviceMailPreferences: 1 } });
  if (!user) return true;
  if (user.isMail === false) return false;
  const preference = user.serviceMailPreferences?.[target[0]];
  if (preference === false) return false;
  if (preference && typeof preference === 'object') return preference.enabled !== false && preference.emails?.[target[1]] !== false;
  return true;
};

export const sendMail = async ({ to, subject, html }) => {
  const transporter = buildTransporter();
  const from = process.env.MAIL_FROM || 'no-reply@example.com';
  const toList = Array.isArray(to) ? to.filter(Boolean) : String(to || '').split(',').map(s => s.trim()).filter(Boolean);
  const allowed = [];
  for (const address of toList) if (await isEnabled(address, html, subject)) allowed.push(address);
  if (!allowed.length) return { skipped: true, reason: 'service-mail-disabled' };
  const mailTo = Array.isArray(to) ? allowed : allowed.join(', ');
  const maskedTo = toList.map((address) => {
    const [local, domain] = String(address).split('@');
    return domain ? `${local.slice(0, 1)}***@${domain}` : '***';
  });
  console.log(`[mail] attempt to=${maskedTo.join(',')} subject=${JSON.stringify(subject || '')}`);
  try {
    const info = await transporter.sendMail({ from, to: mailTo, subject, html });
    console.log(`[mail] sent to=${maskedTo.join(',')} messageId=${info?.messageId || '(mock)'}`);
    return info;
  } catch (err) {
    console.error(`[mail] failed to=${maskedTo.join(',')} code=${err?.code || ''} message=${err?.message || err}`);
    throw err;
  }
};
