import mongoose from 'mongoose';

const seasoningSchema = new mongoose.Schema({
    classification: {
        type: String
    },
    seasoning: {
        type: String,
        required: true
    },
    // グループ専用のオリジナル調味料の場合に設定
    group: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Group',
        default: null
    },
    // 登録者（任意）
    createdBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null
    },
    yomi: {
        type: String
    },
    energy: {
        type: String
    },
    water: {
        type: String
    },
    protein: {
        type: String
    },
    lipid: {
        type: String
    },
    carbohydrate: {
        type: String
    },
    unit: {
        type: [String]  // 例: ['g', 'ml']
    },
    comment: {
        type: String
    },
    favorite: {
        type: Boolean,
        default: false
    },
    entry_date:{
        type: Date,
        default: Date.now
    },
    update_date: {
        type: Date
    },
    used_date: {
        type: Date
    }
});

// 🔹 更新時に update_date を自動設定する
seasoningSchema.pre('findOneAndUpdate', function (next) {
    this.set({ update_date: Date.now() }); // update_date を現在の日時に設定
    next();
});

const existingModel = mongoose.models['Seasoning'];
if (existingModel) {
  mongoose.deleteModel('Seasoning');
}
const Seasoning = mongoose.model('Seasoning', seasoningSchema);
// ES モジュール形式用に default エクスポートを追加
export default Seasoning;
