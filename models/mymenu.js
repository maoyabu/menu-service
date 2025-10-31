import mongoose from 'mongoose';

const mymenuSchema = new mongoose.Schema({
    menu: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Menu',
        required: true
    },
    // お気に入り（♡）
    favorite: {
        type: Boolean,
        default: false
    },
    // 得意料理(ON/OFF)
    skill: {
        type: Boolean,
        default: false
    },
    // 食べたい頻度（1-5）
    frequency: {
        type: Number,
        min: 1,
        max: 5,
        default: 3
    },
    myurl: {
        type: String
    },
    // 共有設定
    share: {
        type: Boolean,
        default: false
    },
    // 共有範囲: 'group' | 'all'
    shareScope: {
        type: String,
        enum: ['group', 'all'],
        default: 'group'
    },
    // 登録元: 'shared'（共有メニューから）| 'url'（レシピサイトから）| 'original'（オリジナル）
    sourceType: {
        type: String,
        enum: ['shared', 'url', 'original'],
        default: 'shared'
    },
    user: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    group: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Group',
        required: true
    },
    entry_date:{
        type: Date,
        default: Date.now
    },
    update_date: {
        type: Date
    }
});

// 🔹 更新時に update_date を自動設定する
mymenuSchema.pre('findOneAndUpdate', function (next) {
    this.set({ update_date: Date.now() }); // update_date を現在の日時に設定
    next();
});

if (mongoose.models.Mymenu) {
  delete mongoose.models.Mymenu;
}
const Mymenu = mongoose.model('Mymenu', mymenuSchema);
// ES モジュール形式用に default エクスポートを追加
export default Mymenu;
