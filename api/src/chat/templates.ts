import { QOBO_CONTACT } from '../rag/qobo-facts.ts';
import type { Language, SmalltalkType } from './router.ts';

/**
 * Fixed replies written in code. Off-topic and small-talk messages never reach an
 * answer model, so these cannot be talked into answering something else.
 * Hindi phrasing avoids gendered verb forms for the assistant.
 */
type Localized = Record<'en' | 'hi' | 'hinglish', string>;

function pick(texts: Localized, language: Language): string {
  return language === 'hi' || language === 'hinglish' ? texts[language] : texts.en;
}

const OFF_TOPIC: Localized = {
  en: "Sorry, I can only help with questions about QOBO and related topics like websites, online stores, SEO, social media marketing and business automation. For example, you could ask how QOBO builds a website through WhatsApp or what our plans include.",
  hi: 'माफ़ कीजिए, मैं सिर्फ़ QOBO और उससे जुड़े विषयों — जैसे वेबसाइट, ऑनलाइन स्टोर, SEO, सोशल मीडिया मार्केटिंग और बिज़नेस ऑटोमेशन — से जुड़े सवालों में मदद के लिए हूँ। उदाहरण के लिए, आप पूछ सकते हैं कि QOBO WhatsApp के ज़रिए वेबसाइट कैसे बनाता है या हमारे प्लान में क्या शामिल है।',
  hinglish:
    'Sorry, main sirf QOBO aur usse jude topics jaise websites, online stores, SEO, social media marketing aur business automation ke sawaalon mein help ke liye hoon. Jaise, aap pooch sakte hain ki QOBO WhatsApp se website kaise banata hai ya hamare plans mein kya milta hai.',
};

const SUGGESTIONS: Localized = {
  en: 'You can ask things like "How does QOBO build a website on WhatsApp?", "What do your plans cost?" or "Do you offer SEO services?"',
  hi: 'आप पूछ सकते हैं: "QOBO WhatsApp पर वेबसाइट कैसे बनाता है?", "आपके प्लान की कीमत क्या है?" या "क्या आप SEO सेवाएँ देते हैं?"',
  hinglish: 'Aap pooch sakte hain: "QOBO WhatsApp pe website kaise banata hai?", "Plans ka price kya hai?" ya "Kya aap SEO services dete ho?"',
};

const SMALLTALK: Record<SmalltalkType, Localized> = {
  greeting: {
    en: `Hi! I'm QOBO's AI assistant. I can help with QOBO's website builder, AI automation, marketing services and plans. ${SUGGESTIONS.en}`,
    hi: `नमस्ते! मैं QOBO का AI असिस्टेंट हूँ। QOBO के वेबसाइट बिल्डर, AI ऑटोमेशन, मार्केटिंग सेवाओं और प्लान के बारे में मदद के लिए हाज़िर हूँ। ${SUGGESTIONS.hi}`,
    hinglish: `Hi! Main QOBO ka AI assistant hoon. QOBO ke website builder, AI automation, marketing services aur plans ke baare mein help ke liye yahan hoon. ${SUGGESTIONS.hinglish}`,
  },
  thanks: {
    en: "You're welcome! Let me know if you have any other questions about QOBO.",
    hi: 'आपका स्वागत है! QOBO के बारे में कोई और सवाल हो तो ज़रूर पूछिए।',
    hinglish: 'Aapka swagat hai! QOBO ke baare mein koi aur sawaal ho toh zaroor poochiye.',
  },
  goodbye: {
    en: `Thanks for chatting with QOBO! If you need us later, you can reach the team on WhatsApp at ${QOBO_CONTACT.whatsappDisplay}.`,
    hi: `QOBO से बात करने के लिए धन्यवाद! बाद में ज़रूरत हो तो हमारी टीम से WhatsApp पर ${QOBO_CONTACT.whatsappDisplay} पर संपर्क करें।`,
    hinglish: `QOBO se baat karne ke liye thank you! Baad mein zaroorat ho toh team se WhatsApp pe ${QOBO_CONTACT.whatsappDisplay} par contact karein.`,
  },
  identity: {
    en: `I'm QOBO's AI assistant, not a human. I answer using information published on QOBO's website. To talk to a person, message the QOBO team on WhatsApp at ${QOBO_CONTACT.whatsappDisplay} or email ${QOBO_CONTACT.email}.`,
    hi: `मैं QOBO का AI असिस्टेंट हूँ, कोई इंसान नहीं। मेरे जवाब QOBO की वेबसाइट पर दी गई जानकारी पर आधारित होते हैं। किसी व्यक्ति से बात करने के लिए QOBO टीम को WhatsApp पर ${QOBO_CONTACT.whatsappDisplay} पर मैसेज करें या ${QOBO_CONTACT.email} पर ईमेल करें।`,
    hinglish: `Main QOBO ka AI assistant hoon, koi insaan nahi. Mere jawab QOBO ki website ki information par based hote hain. Kisi person se baat karne ke liye QOBO team ko WhatsApp pe ${QOBO_CONTACT.whatsappDisplay} par message karein ya ${QOBO_CONTACT.email} par email karein.`,
  },
  other: {
    en: `I'm here to help with anything about QOBO. ${SUGGESTIONS.en}`,
    hi: `मैं QOBO से जुड़े किसी भी सवाल में मदद के लिए हूँ। ${SUGGESTIONS.hi}`,
    hinglish: `Main QOBO se jude kisi bhi sawaal mein help ke liye hoon. ${SUGGESTIONS.hinglish}`,
  },
};

export function offTopicReply(language: Language): string {
  return pick(OFF_TOPIC, language);
}

export function smalltalkReply(type: SmalltalkType, language: Language): string {
  return pick(SMALLTALK[type], language);
}
