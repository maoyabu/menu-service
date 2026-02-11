import mongoose from 'mongoose';
import passportLocalMongoose from 'passport-local-mongoose';

const userSchema = new mongoose.Schema({
  username: {
    type: String,
    required: true,
    unique: true
  },
  displayname: {
    type: String
  },
  email: {
    type: String,
    required: true,
    unique: true
  },
  birth_date: {
    type: Date,
  },
  entry_date: {
    type: Date,
    default: Date.now
  },
  update_date: {
    type: Date
  },
  avatar: {
    type: String,
    default: '/images/default-avatar.png'
  },
  blood: {
    type: String
  },
  rh: {
    type: String
  },
  sex: {
    type: String
  },
  resetPasswordToken: {
    type: String,
    index: true
  },
  resetPasswordExpires: {
    type: Date
  },
  groups: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Group',
    default: []
  }],
  defaultGroup: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Group',
    default: null
  },
  unsubscribe_date: {
    type: Date
  },
  isAdmin: {
    type: Boolean,
    default: false
  },
  isPlanner: {
    type: Boolean,
    default: false
  },
  isMail: {
    type: Boolean,
    default: true
  },
  services: {
    allaboutme: { type: Boolean, default: true },
    finance: { type: Boolean, default: true },
    assets: { type: Boolean, default: true },
    menu: { type: Boolean, default: true }
  },
  preferredService: {
    type: String,
    default: 'plan'
  },
  slideshowSettings: {
    type: {
      type: String,
      default: 'favorites'
    },
    effect: {
      type: String,
      default: 'fade'
    },
    interval: {
      type: Number,
      default: 5
    },
    bgmList: {
      type: [String],
      default: []
    },
    volume: {
      type: Number,
      default: 0.4
    },
    mute: {
      type: Boolean,
      default: false
    }
  },
  weekMenuSettings: {
    breakfastMenus: {
      type: [String],
      default: () => ['モーニング']
    },
    breakfastRatios: {
      japanese: { type: Number, default: 3 },
      western: { type: Number, default: 4 },
      chinese: { type: Number, default: 0 },
      other: { type: Number, default: 0 }
    },
    lunchMenus: {
      type: [String],
      default: () => [
        'カレーライス',
        '丼',
        'パスタ',
        'うどん',
        '焼きそば',
        'そうめん',
        'そば',
        'ちゃんぽん',
        'ラーメン',
        'ハンバーガー',
        'サンドイッチ',
        '定食'
      ]
    },
    lunchRatios: {
      japanese: { type: Number, default: 2 },
      western: { type: Number, default: 3 },
      chinese: { type: Number, default: 2 },
      other: { type: Number, default: 0 }
    },
    breakfastFilterEnabled: {
      type: Boolean,
      default: true
    },
    lunchFilterEnabled: {
      type: Boolean,
      default: true
    }
  }
});

userSchema.plugin(passportLocalMongoose, {
  usernameField: 'email',
  errorMessages: {
    UserExistsError: 'そのユーザー名はすでに使われています',
    MissingPasswordError: 'パスワードを入力してください',
    AttemptTooSoonError: 'アカウントがロックされています。時間をあけて再度試してください',
    TooManyAttemptsError: 'ログインの失敗が何度も続いたため、アカウントがロックされています',
    NoSaltValueStoredError: '認証が出来ませんでした。',
    MissingUsernameError: 'ユーザー名を入力してください',
    IncorrectUsernameError: 'ユーザー名が間違っています',
    IncorrectPasswordError: 'パスワードが間違っています'
  }
});

const User = mongoose.models.User || mongoose.model('User', userSchema);
export default User;
