import mongoose from 'mongoose';

const adminLogSchema = new mongoose.Schema({
  action: {
    type: String,
    required: true
  },
  menu: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Menu'
  },
  menuName: {
    type: String,
    default: ''
  },
  actor: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  detail: {
    type: String,
    default: ''
  },
  createdAt: {
    type: Date,
    default: Date.now,
    index: true
  }
});

adminLogSchema.index({ action: 1, createdAt: -1 });

const existingModel = mongoose.models.AdminLog;
if (existingModel) {
  mongoose.deleteModel('AdminLog');
}
const AdminLog = mongoose.model('AdminLog', adminLogSchema);
export default AdminLog;
