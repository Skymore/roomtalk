const CN_ADJECTIVES = ["可爱", "萌萌", "温柔", "活泼", "聪明", "快乐", "甜蜜", "淘气", "软软", "闪亮", "乖巧", "迷你"];
const CN_NOUNS = ["小猫", "小熊", "小兔", "小鹿", "小狐", "小鸭", "小狗", "小象", "小猪", "小鸟", "花朵", "星星", "气球"];

const EN_ADJECTIVES = ["Fluffy", "Tiny", "Sweet", "Bubbly", "Cuddly", "Sparkly", "Happy", "Cozy", "Rosy", "Playful"];
const EN_NOUNS = ["Bunny", "Kitten", "Puppy", "Panda", "Cookie", "Muffin", "Star", "Fox", "Duckling", "Unicorn", "Whale"];

const HI_ADJECTIVES = ["प्यारा", "छोटा", "मीठा", "चंचल", "सुंदर", "उज्ज्वल", "खुश", "आरामदायक", "रंगीन", "खेलपूर्ण"];
const HI_NOUNS = ["खरगोश", "बिल्ली", "कुत्ता", "पांडा", "कुकी", "तारा", "लोमड़ी", "बतख", "हाथी", "तितली", "फूल"];

const JA_ADJECTIVES = ["ふわふわ", "小さな", "やさしい", "元気な", "きらきら", "楽しい", "のんびり", "かわいい", "陽気な", "まるい"];
const JA_NOUNS = ["うさぎ", "こねこ", "こいぬ", "パンダ", "クッキー", "星", "きつね", "あひる", "花", "くじら", "蝶"];

const KO_ADJECTIVES = ["포근한", "작은", "달콤한", "발랄한", "반짝이는", "즐거운", "느긋한", "귀여운", "상냥한", "동그란"];
const KO_NOUNS = ["토끼", "고양이", "강아지", "판다", "쿠키", "별", "여우", "오리", "꽃", "고래", "나비"];

type RandomSource = () => number;

const pick = (values: string[], random: RandomSource) => values[Math.floor(random() * values.length)];

export const generateRandomName = (language: string, random: RandomSource = Math.random): string => {
  if (language === "zh" || language.startsWith("zh-")) {
    return pick(CN_ADJECTIVES, random) + pick(CN_NOUNS, random);
  }

  if (language === "hi") {
    return `${pick(HI_ADJECTIVES, random)} ${pick(HI_NOUNS, random)}`;
  }

  if (language === "ja" || language.startsWith("ja-")) {
    return pick(JA_ADJECTIVES, random) + pick(JA_NOUNS, random);
  }

  if (language === "ko" || language.startsWith("ko-")) {
    return `${pick(KO_ADJECTIVES, random)} ${pick(KO_NOUNS, random)}`;
  }

  return pick(EN_ADJECTIVES, random) + pick(EN_NOUNS, random);
};

export const getAvatarText = (name: string): string => {
  if (!name) return "?";
  const firstChar = name.charAt(0);
  if (/[\u4e00-\u9fa5]/.test(firstChar)) {
    return firstChar;
  }
  return firstChar.toUpperCase();
};

export const getAvatarColor = (name: string): string => {
  if (!name) return "primary";

  const colors = ["primary", "secondary", "success", "warning", "danger"];
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }

  return colors[Math.abs(hash) % colors.length];
};
