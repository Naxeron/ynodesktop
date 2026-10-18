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
        std::cout << "Event " << ev.id << " at " << ev.x << "," << ev.y << ":\n";
        int page_idx = 0;
        for (const auto& page : ev.pages) {
            std::cout << "  Page " << page_idx++ << ":\n";
            for (const auto& cmd : page.event_commands) {
                std::cout << "    Code " << cmd.code << " Params: ";
                for (auto p : cmd.parameters) std::cout << p << " ";
                std::cout << "\n";
            }
        }
    }
    return 0;
}
