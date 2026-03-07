import mongoose from 'mongoose';

const { Schema } = mongoose;

const menuApiConfigSchema = new Schema({
  url: {
    type: String,
    default: ''
  },
  updatedBy: {
    type: Schema.Types.ObjectId,
    ref: 'User'
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

const MenuApiConfig = mongoose.models.MenuApiConfig || mongoose.model('MenuApiConfig', menuApiConfigSchema);

export default MenuApiConfig;
