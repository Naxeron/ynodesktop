#include <iostream>
#include <vector>
#include <string>
#include <lcf/lmu/reader.h>
#include <lcf/rpg/map.h>
#include <lcf/rpg/event.h>
#include <lcf/rpg/eventpage.h>
#include <lcf/rpg/eventcommand.h>

int main(int argc, char** argv) {
    if (argc < 2) return 1;
    auto map = lcf::LMU_Reader::Load(argv[1], "");
    if (!map) return 1;

    for (const auto& ev : map->events) {
        for (const auto& page : ev.pages) {
            for (const auto& cmd : page.event_commands) {
                if (cmd.code == 10810) {
                    std::cout << "Event " << ev.ID << " (Code 10810):";
                    for (int p : cmd.parameters) {
                        std::cout << " " << p;
                    }
                    std::cout << std::endl;
                }
            }
        }
    }
    return 0;
}
