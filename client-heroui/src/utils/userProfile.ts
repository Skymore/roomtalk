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

const hashString = (value: string): number => {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = value.charCodeAt(i) + ((hash << 5) - hash);
  }
  return Math.abs(hash);
};

export interface SenderColorTheme {
  outlineLight: string;
  outlineDark: string;
  avatarBackground: string;
  avatarForeground: string;
}

const SENDER_COLOR_THEMES: SenderColorTheme[] = [
  {
    outlineLight: "rgba(44, 135, 119, 0.62)",
    outlineDark: "rgba(94, 199, 181, 0.72)",
    avatarBackground: "#5ec7b5",
    avatarForeground: "#0f2521",
  },
  {
    outlineLight: "rgba(174, 97, 41, 0.62)",
    outlineDark: "rgba(219, 143, 83, 0.74)",
    avatarBackground: "#db8f53",
    avatarForeground: "#2d180c",
  },
  {
    outlineLight: "rgba(75, 108, 181, 0.64)",
    outlineDark: "rgba(133, 161, 230, 0.76)",
    avatarBackground: "#7894dd",
    avatarForeground: "#101a35",
  },
  {
    outlineLight: "rgba(159, 82, 133, 0.62)",
    outlineDark: "rgba(221, 130, 181, 0.76)",
    avatarBackground: "#d279aa",
    avatarForeground: "#301326",
  },
  {
    outlineLight: "rgba(84, 126, 63, 0.64)",
    outlineDark: "rgba(144, 188, 113, 0.74)",
    avatarBackground: "#90bc71",
    avatarForeground: "#182511",
  },
  {
    outlineLight: "rgba(130, 101, 39, 0.64)",
    outlineDark: "rgba(215, 178, 85, 0.74)",
    avatarBackground: "#d7b255",
    avatarForeground: "#2a210b",
  },
  {
    outlineLight: "rgba(70, 128, 153, 0.64)",
    outlineDark: "rgba(118, 187, 216, 0.76)",
    avatarBackground: "#76bbd8",
    avatarForeground: "#102431",
  },
  {
    outlineLight: "rgba(149, 88, 71, 0.62)",
    outlineDark: "rgba(211, 134, 112, 0.74)",
    avatarBackground: "#d38670",
    avatarForeground: "#2c1711",
  },
  {
    outlineLight: "rgba(93, 91, 170, 0.62)",
    outlineDark: "rgba(154, 152, 232, 0.76)",
    avatarBackground: "#9a98e8",
    avatarForeground: "#18173a",
  },
  {
    outlineLight: "rgba(171, 72, 103, 0.62)",
    outlineDark: "rgba(224, 125, 154, 0.76)",
    avatarBackground: "#e07d9a",
    avatarForeground: "#34111e",
  },
  {
    outlineLight: "rgba(58, 139, 92, 0.64)",
    outlineDark: "rgba(104, 205, 141, 0.74)",
    avatarBackground: "#68cd8d",
    avatarForeground: "#0f2a19",
  },
  {
    outlineLight: "rgba(125, 112, 52, 0.64)",
    outlineDark: "rgba(202, 190, 102, 0.74)",
    avatarBackground: "#cabe66",
    avatarForeground: "#28230e",
  },
  {
    outlineLight: "rgba(84, 103, 154, 0.64)",
    outlineDark: "rgba(140, 164, 200, 0.76)",
    avatarBackground: "#8ca4c8",
    avatarForeground: "#132033",
  },
  {
    outlineLight: "rgba(171, 77, 77, 0.62)",
    outlineDark: "rgba(225, 139, 139, 0.74)",
    avatarBackground: "#e18b8b",
    avatarForeground: "#341414",
  },
  {
    outlineLight: "rgba(62, 139, 119, 0.64)",
    outlineDark: "rgba(119, 197, 166, 0.74)",
    avatarBackground: "#77c5a6",
    avatarForeground: "#10281e",
  },
  {
    outlineLight: "rgba(141, 82, 162, 0.62)",
    outlineDark: "rgba(199, 146, 214, 0.76)",
    avatarBackground: "#c792d6",
    avatarForeground: "#2d1535",
  },
];

export const SENDER_COLOR_THEME_COUNT = SENDER_COLOR_THEMES.length;

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

  return colors[hashString(name) % colors.length];
};

export const getSenderColorTheme = (clientId: string): SenderColorTheme => {
  if (!clientId) return SENDER_COLOR_THEMES[0];
  return SENDER_COLOR_THEMES[hashString(clientId) % SENDER_COLOR_THEMES.length];
};
