import mongoose from 'mongoose';

const searchLogSchema = new mongoose.Schema({
  term: { type: String, required: true, index: true },
  source: { type: String, default: 'keyword', index: true }, // e.g. shared-list, mytop
  type: { type: String, default: 'keyword', index: true },   // keyword | genre
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  group: { type: mongoose.Schema.Types.ObjectId, ref: 'Group' }
}, { timestamps: true });

const SearchLog = mongoose.models.SearchLog || mongoose.model('SearchLog', searchLogSchema);
export default SearchLog;
