import mongoose from 'mongoose';

const { Schema } = mongoose;

const mailTemplateSettingSchema = new Schema({
  templateName: { type: String, required: true, unique: true },
  enabled: { type: Boolean, default: false },
  timing: { type: String, default: '' }, // free-form timing memo/cron description
  updatedBy: { type: Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

const MailTemplateSetting = mongoose.models.MailTemplateSetting || mongoose.model('MailTemplateSetting', mailTemplateSettingSchema);

export default MailTemplateSetting;
