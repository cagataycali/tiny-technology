import { headers } from "next/headers"; 
import Chat from "@/components/chat/Chat"
import { getWeatherData } from "@/lib/utils";

export default async function NotFound(props: { name?: string }) {
  const headersList = await headers();
  const parsedCity = headersList.get("x-vercel-ip-city");
  const city =
    !parsedCity || parsedCity === "null" ? "San Francisco" : parsedCity;
  const data = await getWeatherData(city);
  // Unclaimed slug: the calm hero ("Nobody has claimed … yet — it could be
  // yours") is the whole pitch. A seeded systemKnowledge would render as an
  // assistant bubble at turn zero and step on that hero, so leave it empty —
  // the first thing the visitor sees is the offer, not a canned monologue.
  const tiny = {
    systemPrompt: `tiny.technology/${props.name || "this name"} is unclaimed. Send a message to claim it and bring your own AI to life.`,
    systemKnowledge: "",
  }

  return <Chat tiny={tiny} systemPrompt={tiny.systemPrompt} name={props.name || 'tiny'} systemKnowledge={tiny.systemKnowledge} metadata={data} unclaimed />
}
