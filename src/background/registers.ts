// Every Wave 2 feature's background registration, imported synchronously at startup (MV3 listeners must
// exist in the first tick). Each stream fills its own file.
import './workflows/register';
import './agents/register';
import './inbox/register';
import './integrations/register';
import './models/register';
import './tts/register';
import './companion/register';
import './voice/engines/register';
import './history/register';
import './whatsapp/register';
import './chats/register';
import './personalities/register';
import './audio-devices/register';
