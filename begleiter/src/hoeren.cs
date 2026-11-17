// Offline-Zuhören für den Harnes Begleiter (klassische Windows-Spracherkennung, Deutsch).
// Wird nur benutzt, wenn die Online-Spracherkennung von Windows ausgeschaltet ist.
// Steuerung über stdin: "start" / "stop". Ausgabe: "H <text>" (Zwischenstand), "F <text>" (fertig), "S" (beendet).
using System;
using System.Globalization;
using System.Speech.Recognition;
using System.Text;

class Hoeren
{
    static readonly object Lock = new object();

    static void Out(string kind, string text)
    {
        lock (Lock)
        {
            Console.Out.WriteLine(kind + " " + (text ?? "").Replace("\r", " ").Replace("\n", " "));
            Console.Out.Flush();
        }
    }

    static void Main()
    {
        Console.OutputEncoding = new UTF8Encoding(false);
        SpeechRecognitionEngine eng;
        try
        {
            eng = new SpeechRecognitionEngine(new CultureInfo("de-DE"));
            eng.LoadGrammar(new DictationGrammar());
            eng.SetInputToDefaultAudioDevice();
        }
        catch (Exception e)
        {
            Out("E", "Offline-Spracherkennung ging nicht: " + e.Message);
            return;
        }
        eng.SpeechHypothesized += (s, e) => Out("H", e.Result.Text);
        eng.SpeechRecognized += (s, e) => { if (e.Result.Confidence > 0.15) Out("F", e.Result.Text); };
        eng.RecognizeCompleted += (s, e) => Out("S", "");
        Out("R", "");
        bool running = false;
        string line;
        while ((line = Console.In.ReadLine()) != null)
        {
            if (line == "start" && !running)
            {
                eng.RecognizeAsync(RecognizeMode.Multiple);
                running = true;
            }
            else if (line == "stop" && running)
            {
                eng.RecognizeAsyncStop();
                running = false;
            }
            else if (line == "stop")
            {
                Out("S", "");
            }
        }
    }
}
